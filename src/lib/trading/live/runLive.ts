import { env } from "@alea/constants/env";
import {
  EMA50_BOOTSTRAP_BARS,
  ORDER_CANCEL_MARGIN_MS,
  STAKE_USD,
  WINDOW_SUMMARY_DELAY_MS,
} from "@alea/constants/trading";
import { fetchRecentFiveMinuteBars } from "@alea/lib/livePrices/binancePerp/fetchRecentFiveMinuteBars";
import { streamBinancePerpLive } from "@alea/lib/livePrices/binancePerp/streamBinancePerpLive";
import {
  createFiveMinuteEmaTracker,
  type FiveMinuteEmaTracker,
} from "@alea/lib/livePrices/fiveMinuteEmaTracker";
import {
  currentWindowStartMs,
  FIVE_MINUTES_MS,
  flooredRemainingMinutes,
} from "@alea/lib/livePrices/fiveMinuteWindow";
import type {
  ClosedFiveMinuteBar,
  LivePriceTick,
} from "@alea/lib/livePrices/types";
import { getPolymarketAuthState } from "@alea/lib/polymarket/getPolymarketClobClient";
import { fetchUpDownBook } from "@alea/lib/polymarket/markets/fetchUpDownBook";
import { findUpDownMarket } from "@alea/lib/polymarket/markets/findUpDownMarket";
import type {
  UpDownBookSnapshot,
  UpDownMarket,
} from "@alea/lib/polymarket/markets/types";
import type { UserChannelHandle } from "@alea/lib/polymarket/userChannel/streamUserChannel";
import { streamUserChannel } from "@alea/lib/polymarket/userChannel/streamUserChannel";
import { sendTelegramMessage } from "@alea/lib/telegram/sendTelegramMessage";
import { evaluateDecision } from "@alea/lib/trading/decision/evaluateDecision";
import type { TradeDecision } from "@alea/lib/trading/decision/types";
import type { LiveEvent } from "@alea/lib/trading/live/types";
import { cancelOpenOrder } from "@alea/lib/trading/orders/cancelOpenOrder";
import { hydrateMarketState } from "@alea/lib/trading/orders/hydrateMarketState";
import { placeMakerLimitBuy } from "@alea/lib/trading/orders/placeMakerLimitBuy";
import { settleFilled } from "@alea/lib/trading/state/settleFilled";
import type { AssetSlot } from "@alea/lib/trading/state/types";
import { formatOrderPlaced } from "@alea/lib/trading/telegram/formatOrderPlaced";
import {
  type AssetWindowOutcome,
  formatWindowSummary,
} from "@alea/lib/trading/telegram/formatWindowSummary";
import type {
  ProbabilityTable,
  RemainingMinutes,
} from "@alea/lib/trading/types";
import type { Asset } from "@alea/types/assets";
import type { ClobClient } from "@polymarket/clob-client";

const TICK_INTERVAL_MS = 250;
const BOOK_POLL_INTERVAL_MS = 1_500;

export type RunLiveParams = {
  readonly assets: readonly Asset[];
  readonly table: ProbabilityTable;
  readonly minEdge: number;
  readonly telegramBotToken: string;
  readonly telegramChatId: string;
  readonly emit: (event: LiveEvent) => void;
  readonly signal: AbortSignal;
};

/**
 * Long-running live trader. Same shape as `runDryRun` but actually
 * places maker-only limit BUY orders, watches fills via Polymarket's
 * user WS channel, settles each window with real PnL net of fees,
 * and ships a per-window Telegram summary.
 *
 * Concurrency invariants:
 *   - Per asset, at most one open order *or* one position at a time
 *     (chunk-2 spec). Enforced by the slot state machine: a new order
 *     is only placed when `slot.kind === "empty"`. The slot
 *     transitions atomically to `active` *before* the async
 *     postOrder call, so concurrent ticks can't double-fire.
 *   - Per window, the wrap-up timer fires exactly once at
 *     `windowEndMs + WINDOW_SUMMARY_DELAY_MS`. It cancels any still-
 *     resting orders, settles fills, builds the outcome list, and
 *     ships the Telegram summary.
 *   - All in-memory state is wiped at window rollover; Polymarket is
 *     the source of truth, so a process crash and restart simply
 *     re-hydrates from `getOpenOrders` + `getTrades`.
 */
export async function runLive({
  assets,
  table,
  minEdge,
  telegramBotToken,
  telegramChatId,
  emit,
  signal,
}: RunLiveParams): Promise<void> {
  const auth = await getPolymarketAuthState();
  const client = auth.client;
  emit({
    kind: "info",
    atMs: Date.now(),
    message: `live trader starting: assets=${assets.join(",")} stake=$${STAKE_USD} minEdge=${minEdge.toFixed(3)} wallet=${auth.walletAddress.slice(0, 10)}...`,
  });

  const emas = new Map<Asset, FiveMinuteEmaTracker>();
  const lastTick = new Map<Asset, LivePriceTick>();
  const books = new Map<Asset, UpDownBookSnapshot>();
  const lastClosedBars = new Map<Asset, ClosedFiveMinuteBar>();
  const windows = new Map<number, WindowRecord>();
  const conditionIdIndex = new Map<
    string,
    { readonly windowStartMs: number; readonly asset: Asset }
  >();

  for (const asset of assets) {
    emas.set(asset, createFiveMinuteEmaTracker());
  }

  await hydrateEmas({ assets, emas, signal, emit });
  if (signal.aborted) {
    return;
  }

  const feedHandle = streamBinancePerpLive({
    assets,
    onTick: (tick) => {
      lastTick.set(tick.asset, tick);
    },
    onBarClose: (bar) => {
      lastClosedBars.set(bar.asset, bar);
      const tracker = emas.get(bar.asset);
      if (tracker !== undefined) {
        const incorporated = tracker.append(bar);
        if (incorporated) {
          emit({
            kind: "info",
            atMs: Date.now(),
            message: `${labelAsset(bar.asset)} 5m close ${new Date(bar.openTimeMs).toISOString().slice(11, 16)} UTC: close=${bar.close}, ema50=${tracker.currentValue()?.toFixed(2) ?? "warming"}`,
          });
        }
      }
    },
    onConnect: () =>
      emit({
        kind: "info",
        atMs: Date.now(),
        message: "binance-perp ws connected",
      }),
    onDisconnect: (reason) =>
      emit({
        kind: "warn",
        atMs: Date.now(),
        message: `binance-perp ws disconnected: ${reason}`,
      }),
    onError: (error) =>
      emit({
        kind: "error",
        atMs: Date.now(),
        message: `binance-perp ws error: ${error.message}`,
      }),
  });

  // Hold the user-channel handle through a single-field box so the
  // closure mutations don't get narrowed back to `null` by control-
  // flow analysis at cleanup.
  const userChannelBox: { handle: UserChannelHandle | null } = { handle: null };
  const restartUserChannel = (conditionIds: readonly string[]) => {
    if (conditionIds.length === 0) {
      return;
    }
    if (userChannelBox.handle !== null) {
      void userChannelBox.handle.stop();
      userChannelBox.handle = null;
    }
    userChannelBox.handle = streamUserChannel({
      conditionIds,
      onFill: (fill) => {
        const handle = conditionIdIndex.get(fill.conditionId);
        if (handle === undefined) {
          return;
        }
        const window = windows.get(handle.windowStartMs);
        if (window === undefined) {
          return;
        }
        const record = window.perAsset.get(handle.asset);
        if (record === undefined) {
          return;
        }
        applyFill({
          asset: handle.asset,
          record,
          fill: {
            tokenId: fill.tokenId,
            price: fill.price,
            size: fill.size,
            feeRateBps: fill.feeRateBps,
          },
          emit,
        });
      },
      onConnect: () =>
        emit({
          kind: "info",
          atMs: Date.now(),
          message: "polymarket user ws connected",
        }),
      onDisconnect: (reason) =>
        emit({
          kind: "warn",
          atMs: Date.now(),
          message: `polymarket user ws disconnected: ${reason}`,
        }),
      onError: (err) =>
        emit({
          kind: "error",
          atMs: Date.now(),
          message: `polymarket user ws error: ${err.message}`,
        }),
    });
  };

  const bookPollTimer = setInterval(() => {
    if (signal.aborted) {
      return;
    }
    for (const window of windows.values()) {
      if (window.summarySent) {
        continue;
      }
      for (const record of window.perAsset.values()) {
        const market = record.market;
        if (market === null) {
          continue;
        }
        void refreshBook({
          asset: record.asset,
          market,
          books,
          emit,
          signal,
        });
      }
    }
  }, BOOK_POLL_INTERVAL_MS);

  const tickTimer = setInterval(() => {
    if (signal.aborted) {
      return;
    }
    const nowMs = Date.now();
    const startMs = currentWindowStartMs({ nowMs });
    let window = windows.get(startMs);
    if (window === undefined) {
      window = {
        windowStartMs: startMs,
        windowEndMs: startMs + FIVE_MINUTES_MS,
        perAsset: new Map(),
        wrapUpScheduled: false,
        summarySent: false,
        cancelTimer: null,
        wrapUpTimer: null,
      };
      windows.set(startMs, window);
      const order = window;
      for (const asset of assets) {
        const record: AssetWindowRecord = {
          asset,
          market: null,
          marketStatus: "pending",
          line: lastTick.get(asset)?.mid ?? null,
          lineCapturedAtMs: lastTick.has(asset) ? nowMs : null,
          lastDecisionRemaining: null,
          slot: { kind: "empty" },
        };
        order.perAsset.set(asset, record);
        void hydrateAsset({
          asset,
          record,
          window: order,
          client,
          conditionIdIndex,
          onSubscribe: (ids) => restartUserChannel(ids),
          allWindows: windows,
          signal,
          emit,
        });
      }
      // Schedule wrap-up + cancel margin for this window.
      const cancelAtMs = order.windowEndMs - ORDER_CANCEL_MARGIN_MS;
      const wrapUpAtMs = order.windowEndMs + WINDOW_SUMMARY_DELAY_MS;
      const cancelDelay = Math.max(0, cancelAtMs - nowMs);
      const wrapUpDelay = Math.max(0, wrapUpAtMs - nowMs);
      order.cancelTimer = setTimeout(() => {
        order.cancelTimer = null;
        void cancelResidualOrders({ window: order, client, emit });
      }, cancelDelay);
      order.wrapUpTimer = setTimeout(() => {
        order.wrapUpTimer = null;
        void wrapUpWindow({
          window: order,
          lastClosedBars,
          telegramBotToken,
          telegramChatId,
          windowsAll: windows,
          conditionIdIndex,
          emit,
        });
      }, wrapUpDelay);
    }

    for (const asset of assets) {
      const record = window.perAsset.get(asset);
      if (record === undefined) {
        continue;
      }
      // Capture line on first tick we observe after window open.
      if (record.line === null) {
        const tick = lastTick.get(asset);
        if (tick !== undefined) {
          record.line = tick.mid;
          record.lineCapturedAtMs = tick.receivedAtMs;
          emit({
            kind: "info",
            atMs: nowMs,
            message: `${labelAsset(asset)} line captured: ${tick.mid.toFixed(decimalsFor({ asset }))}`,
          });
        }
      }
      const remaining = flooredRemainingMinutes({
        windowStartMs: window.windowStartMs,
        nowMs,
      });
      // Evaluate when bucket flips OR continuously while we still
      // have an empty slot — the latter handles the case where market
      // discovery or book hydration completes mid-bucket. Once the
      // slot is non-empty we stop evaluating for this window.
      const bucketChanged = remaining !== record.lastDecisionRemaining;
      const slotEmpty = record.slot.kind === "empty";
      if (remaining === null) {
        record.lastDecisionRemaining = null;
        continue;
      }
      if (!bucketChanged && !slotEmpty) {
        continue;
      }

      const tick = lastTick.get(asset);
      const tracker = emas.get(asset);
      const market = record.market;
      const book = books.get(asset);
      if (
        tick === undefined ||
        tracker === undefined ||
        market === null ||
        record.line === null
      ) {
        continue;
      }
      const decision = evaluateDecision({
        asset,
        windowStartMs: window.windowStartMs,
        nowMs,
        line: record.line,
        currentPrice: tick.mid,
        ema50: tracker.currentValue(),
        upBestBid: book?.up.bestBid ?? null,
        downBestBid: book?.down.bestBid ?? null,
        upTokenId: market.upYesTokenId,
        downTokenId: market.downYesTokenId,
        table,
        minEdge,
      });
      if (bucketChanged) {
        record.lastDecisionRemaining = remaining;
        emit({ kind: "decision", atMs: nowMs, decision });
      }
      if (
        decision.kind === "trade" &&
        record.slot.kind === "empty" &&
        market.acceptingOrders
      ) {
        // Place synchronously-marked: flip slot first so the next tick
        // sees a non-empty slot and won't re-fire placement while the
        // network call is in flight.
        const placeholderSlot: Extract<AssetSlot, { kind: "active" }> = {
          kind: "active",
          market,
          side: decision.chosen.side,
          tokenId: decision.chosen.tokenId,
          orderId: null,
          limitPrice: decision.chosen.bid ?? 0,
          sharesFilled: 0,
          costUsd: 0,
          feeRateBpsAvg: 0,
        };
        record.slot = placeholderSlot;
        void placeAndAlert({
          client,
          record,
          decision,
          tick,
          window,
          telegramBotToken,
          telegramChatId,
          emit,
        });
      }
    }
  }, TICK_INTERVAL_MS);

  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

  clearInterval(bookPollTimer);
  clearInterval(tickTimer);
  for (const window of windows.values()) {
    if (window.cancelTimer !== null) {
      clearTimeout(window.cancelTimer);
    }
    if (window.wrapUpTimer !== null) {
      clearTimeout(window.wrapUpTimer);
    }
  }
  await feedHandle.stop();
  if (userChannelBox.handle !== null) {
    await userChannelBox.handle.stop();
  }
  emit({ kind: "info", atMs: Date.now(), message: "live trader stopped" });
}

type WindowRecord = {
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly perAsset: Map<Asset, AssetWindowRecord>;
  wrapUpScheduled: boolean;
  summarySent: boolean;
  cancelTimer: ReturnType<typeof setTimeout> | null;
  wrapUpTimer: ReturnType<typeof setTimeout> | null;
};

type AssetWindowRecord = {
  readonly asset: Asset;
  market: UpDownMarket | null;
  marketStatus: "pending" | "ready" | "missing" | "error";
  line: number | null;
  lineCapturedAtMs: number | null;
  lastDecisionRemaining: RemainingMinutes | null;
  slot: AssetSlot;
};

async function hydrateEmas({
  assets,
  emas,
  signal,
  emit,
}: {
  readonly assets: readonly Asset[];
  readonly emas: Map<Asset, FiveMinuteEmaTracker>;
  readonly signal: AbortSignal;
  readonly emit: (event: LiveEvent) => void;
}): Promise<void> {
  for (const asset of assets) {
    if (signal.aborted) {
      return;
    }
    try {
      const bars = await fetchRecentFiveMinuteBars({
        asset,
        count: EMA50_BOOTSTRAP_BARS,
        signal,
      });
      const tracker = emas.get(asset);
      if (tracker !== undefined) {
        for (const bar of bars) {
          tracker.append(bar);
        }
      }
      const ema = tracker?.currentValue();
      emit({
        kind: "info",
        atMs: Date.now(),
        message: `${labelAsset(asset)} hydrated ${bars.length} closed 5m bars, ema50=${ema === null || ema === undefined ? "warming" : ema.toFixed(2)}`,
      });
    } catch (error) {
      emit({
        kind: "warn",
        atMs: Date.now(),
        message: `${labelAsset(asset)} ema bootstrap failed: ${(error as Error).message}`,
      });
    }
  }
}

async function hydrateAsset({
  asset,
  record,
  window,
  client,
  conditionIdIndex,
  onSubscribe,
  allWindows,
  signal,
  emit,
}: {
  readonly asset: Asset;
  readonly record: AssetWindowRecord;
  readonly window: WindowRecord;
  readonly client: ClobClient;
  readonly conditionIdIndex: Map<
    string,
    { readonly windowStartMs: number; readonly asset: Asset }
  >;
  readonly onSubscribe: (conditionIds: readonly string[]) => void;
  readonly allWindows: ReadonlyMap<number, WindowRecord>;
  readonly signal: AbortSignal;
  readonly emit: (event: LiveEvent) => void;
}): Promise<void> {
  const windowStartUnixSeconds = Math.floor(window.windowStartMs / 1000);
  let market: UpDownMarket | null;
  try {
    market = await findUpDownMarket({
      asset,
      windowStartUnixSeconds,
      signal,
    });
  } catch (error) {
    record.marketStatus = "error";
    emit({
      kind: "error",
      atMs: Date.now(),
      message: `${labelAsset(asset)} market discovery failed: ${(error as Error).message}`,
    });
    return;
  }
  if (market === null) {
    record.marketStatus = "missing";
    emit({
      kind: "warn",
      atMs: Date.now(),
      message: `${labelAsset(asset)} no Polymarket market for window ${new Date(window.windowStartMs).toISOString().slice(11, 16)}`,
    });
    return;
  }
  record.market = market;
  record.marketStatus = "ready";
  conditionIdIndex.set(market.conditionId, {
    windowStartMs: window.windowStartMs,
    asset,
  });
  // Re-subscribe the user WS to include this conditionId.
  const ids: string[] = [];
  for (const w of allWindows.values()) {
    if (w.summarySent) {
      continue;
    }
    for (const r of w.perAsset.values()) {
      if (r.market !== null) {
        ids.push(r.market.conditionId);
      }
    }
  }
  onSubscribe(ids);

  // Hydrate any leftover state from a previous run.
  try {
    const hydration = await hydrateMarketState({
      client,
      conditionId: market.conditionId,
      upTokenId: market.upYesTokenId,
      downTokenId: market.downYesTokenId,
    });
    if (hydration.openOrder !== null || hydration.fillState !== null) {
      const fill = hydration.fillState;
      const order = hydration.openOrder;
      const side = fill?.side ?? order?.side ?? null;
      if (side !== null) {
        record.slot = {
          kind: "active",
          market,
          side,
          tokenId:
            fill?.tokenId ??
            (side === "up" ? market.upYesTokenId : market.downYesTokenId),
          orderId: order?.orderId ?? null,
          limitPrice: order?.limitPrice ?? fill?.costUsd ?? 0,
          sharesFilled: fill?.sharesFilled ?? 0,
          costUsd: fill?.costUsd ?? 0,
          feeRateBpsAvg: fill?.feeRateBps ?? 0,
        };
        emit({
          kind: "info",
          atMs: Date.now(),
          message: `${labelAsset(asset)} hydrated leftover state: side=${side} order=${order?.orderId ?? "none"} filled=${fill?.sharesFilled ?? 0}`,
        });
      }
    }
  } catch (error) {
    emit({
      kind: "warn",
      atMs: Date.now(),
      message: `${labelAsset(asset)} state hydration failed (continuing with empty slot): ${(error as Error).message}`,
    });
  }

  emit({
    kind: "info",
    atMs: Date.now(),
    message: `${labelAsset(asset)} discovered ${market.slug}, accepting=${market.acceptingOrders}`,
  });
}

async function refreshBook({
  asset,
  market,
  books,
  emit,
  signal,
}: {
  readonly asset: Asset;
  readonly market: UpDownMarket;
  readonly books: Map<Asset, UpDownBookSnapshot>;
  readonly emit: (event: LiveEvent) => void;
  readonly signal: AbortSignal;
}): Promise<void> {
  try {
    const book = await fetchUpDownBook({ market, signal });
    books.set(asset, book);
  } catch (error) {
    emit({
      kind: "warn",
      atMs: Date.now(),
      message: `${labelAsset(asset)} book refresh failed: ${(error as Error).message}`,
    });
  }
}

async function placeAndAlert({
  client,
  record,
  decision,
  tick,
  window,
  telegramBotToken,
  telegramChatId,
  emit,
}: {
  readonly client: ClobClient;
  readonly record: AssetWindowRecord;
  readonly decision: Extract<TradeDecision, { kind: "trade" }>;
  readonly tick: LivePriceTick;
  readonly window: WindowRecord;
  readonly telegramBotToken: string;
  readonly telegramChatId: string;
  readonly emit: (event: LiveEvent) => void;
}): Promise<void> {
  const market = record.market;
  if (market === null || decision.chosen.bid === null) {
    record.slot = { kind: "empty" };
    return;
  }
  try {
    const placed = await placeMakerLimitBuy({
      client,
      side: decision.chosen.side,
      tokenId: decision.chosen.tokenId,
      limitPrice: decision.chosen.bid,
      negRisk: market.negRisk,
      feeRateBps: 0,
    });
    record.slot = {
      kind: "active",
      market,
      side: placed.side,
      tokenId: placed.tokenId,
      orderId: placed.orderId,
      limitPrice: placed.limitPrice,
      sharesFilled: 0,
      costUsd: 0,
      feeRateBpsAvg: placed.feeRateBps,
    };
    if (record.slot.kind === "active") {
      const slotForEvent = record.slot;
      emit({
        kind: "order-placed",
        atMs: Date.now(),
        asset: record.asset,
        slot: slotForEvent,
      });
    }
    const linePrice = record.line ?? tick.mid;
    const message = formatOrderPlaced({
      asset: record.asset,
      side: placed.side,
      stakeUsd: STAKE_USD,
      underlyingPrice: tick.mid,
      linePrice,
      windowEndMs: window.windowEndMs,
      nowMs: Date.now(),
    });
    try {
      await sendTelegramMessage({
        botToken: telegramBotToken,
        chatId: telegramChatId,
        text: message,
      });
    } catch (error) {
      emit({
        kind: "warn",
        atMs: Date.now(),
        message: `${labelAsset(record.asset)} telegram alert failed: ${(error as Error).message}`,
      });
    }
  } catch (error) {
    record.slot = { kind: "empty" };
    emit({
      kind: "error",
      atMs: Date.now(),
      message: `${labelAsset(record.asset)} place failed: ${(error as Error).message}`,
    });
  }
}

function applyFill({
  asset,
  record,
  fill,
  emit,
}: {
  readonly asset: Asset;
  readonly record: AssetWindowRecord;
  readonly fill: {
    readonly tokenId: string;
    readonly price: number;
    readonly size: number;
    readonly feeRateBps: number;
  };
  readonly emit: (event: LiveEvent) => void;
}): void {
  if (record.slot.kind !== "active") {
    return;
  }
  if (record.slot.tokenId !== fill.tokenId) {
    return;
  }
  const newShares = record.slot.sharesFilled + fill.size;
  const newCost = record.slot.costUsd + fill.size * fill.price;
  const weightedFee =
    (record.slot.feeRateBpsAvg * record.slot.sharesFilled +
      fill.feeRateBps * fill.size) /
    Math.max(1, newShares);
  const fullyFilled = newShares >= STAKE_USD / record.slot.limitPrice - 1e-6;
  const updated: Extract<AssetSlot, { kind: "active" }> = {
    kind: "active",
    market: record.slot.market,
    side: record.slot.side,
    tokenId: record.slot.tokenId,
    orderId: fullyFilled ? null : record.slot.orderId,
    limitPrice: record.slot.limitPrice,
    sharesFilled: newShares,
    costUsd: newCost,
    feeRateBpsAvg: weightedFee,
  };
  record.slot = updated;
  emit({
    kind: "fill",
    atMs: Date.now(),
    asset,
    slot: updated,
  });
}

async function cancelResidualOrders({
  window,
  client,
  emit,
}: {
  readonly window: WindowRecord;
  readonly client: ClobClient;
  readonly emit: (event: LiveEvent) => void;
}): Promise<void> {
  for (const record of window.perAsset.values()) {
    if (record.slot.kind !== "active" || record.slot.orderId === null) {
      continue;
    }
    const orderId = record.slot.orderId;
    const result = await cancelOpenOrder({ client, orderId });
    if (record.slot.kind === "active") {
      record.slot = {
        kind: "active",
        market: record.slot.market,
        side: record.slot.side,
        tokenId: record.slot.tokenId,
        orderId: null,
        limitPrice: record.slot.limitPrice,
        sharesFilled: record.slot.sharesFilled,
        costUsd: record.slot.costUsd,
        feeRateBpsAvg: record.slot.feeRateBpsAvg,
      };
    }
    emit({
      kind: result.accepted ? "info" : "warn",
      atMs: Date.now(),
      message: `${labelAsset(record.asset)} cancel ${orderId.slice(0, 10)}…: ${result.accepted ? "ok" : (result.errorMessage ?? "rejected")}`,
    });
  }
}

async function wrapUpWindow({
  window,
  lastClosedBars,
  telegramBotToken,
  telegramChatId,
  windowsAll,
  conditionIdIndex,
  emit,
}: {
  readonly window: WindowRecord;
  readonly lastClosedBars: ReadonlyMap<Asset, ClosedFiveMinuteBar>;
  readonly telegramBotToken: string;
  readonly telegramChatId: string;
  readonly windowsAll: Map<number, WindowRecord>;
  readonly conditionIdIndex: Map<
    string,
    { readonly windowStartMs: number; readonly asset: Asset }
  >;
  readonly emit: (event: LiveEvent) => void;
}): Promise<void> {
  if (window.summarySent) {
    return;
  }
  window.summarySent = true;

  const outcomes: AssetWindowOutcome[] = [];
  for (const record of window.perAsset.values()) {
    const outcome = settleRecord({ record, lastClosedBars });
    outcomes.push(outcome);
  }

  const body = formatWindowSummary({ outcomes });
  emit({
    kind: "window-summary",
    atMs: Date.now(),
    windowStartMs: window.windowStartMs,
    windowEndMs: window.windowEndMs,
    body,
  });

  try {
    await sendTelegramMessage({
      botToken: telegramBotToken,
      chatId: telegramChatId,
      text: body,
    });
  } catch (error) {
    emit({
      kind: "warn",
      atMs: Date.now(),
      message: `window summary telegram send failed: ${(error as Error).message}`,
    });
  }

  // Drop the window from the index now that we're done with it. The
  // user-channel subscription will refresh the next time a new market
  // is discovered.
  for (const record of window.perAsset.values()) {
    if (record.market !== null) {
      conditionIdIndex.delete(record.market.conditionId);
    }
  }
  windowsAll.delete(window.windowStartMs);
}

function settleRecord({
  record,
  lastClosedBars,
}: {
  readonly record: AssetWindowRecord;
  readonly lastClosedBars: ReadonlyMap<Asset, ClosedFiveMinuteBar>;
}): AssetWindowOutcome {
  if (record.slot.kind === "empty") {
    return { asset: record.asset, kind: "none" };
  }
  if (record.slot.kind === "active") {
    if (record.line === null) {
      return record.slot.sharesFilled > 0
        ? {
            asset: record.asset,
            kind: "traded",
            side: record.slot.side,
            fillPrice: record.slot.costUsd / record.slot.sharesFilled,
            sharesFilled: record.slot.sharesFilled,
            costUsd: record.slot.costUsd,
            feesUsd: 0,
            netPnlUsd: -record.slot.costUsd,
            won: false,
          }
        : {
            asset: record.asset,
            kind: "unfilled",
            side: record.slot.side,
            limitPrice: record.slot.limitPrice,
          };
    }
    const closedBar = lastClosedBars.get(record.asset);
    const finalPrice = closedBar?.close ?? record.line;
    const settled = settleFilled({
      active: record.slot,
      finalPrice,
      line: record.line,
    });
    record.slot = settled;
    if (settled.kind === "noFill") {
      return {
        asset: record.asset,
        kind: "unfilled",
        side: settled.side,
        limitPrice: settled.limitPrice,
      };
    }
    return {
      asset: record.asset,
      kind: "traded",
      side: settled.side,
      fillPrice: settled.fillPriceAvg,
      sharesFilled: settled.sharesFilled,
      costUsd: settled.costUsd,
      feesUsd: settled.feesUsd,
      netPnlUsd: settled.netPnlUsd,
      won: settled.won,
    };
  }
  if (record.slot.kind === "noFill") {
    return {
      asset: record.asset,
      kind: "unfilled",
      side: record.slot.side,
      limitPrice: record.slot.limitPrice,
    };
  }
  // settled
  return {
    asset: record.asset,
    kind: "traded",
    side: record.slot.side,
    fillPrice: record.slot.fillPriceAvg,
    sharesFilled: record.slot.sharesFilled,
    costUsd: record.slot.costUsd,
    feesUsd: record.slot.feesUsd,
    netPnlUsd: record.slot.netPnlUsd,
    won: record.slot.won,
  };
}

function labelAsset(asset: Asset): string {
  return asset.toUpperCase().padEnd(5);
}

function decimalsFor({ asset }: { readonly asset: Asset }): number {
  switch (asset) {
    case "btc":
    case "eth":
      return 2;
    case "sol":
    case "xrp":
      return 4;
    case "doge":
      return 5;
  }
}

// Quiet the linter: env is referenced by the CLI command at startup
// to validate Telegram creds, but we want this module to be self-
// contained for tests.
void env;
