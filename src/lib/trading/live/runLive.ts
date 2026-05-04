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
import type { LiveEvent } from "@alea/lib/trading/live/types";
import { cancelOpenOrder } from "@alea/lib/trading/orders/cancelOpenOrder";
import { hydrateMarketState } from "@alea/lib/trading/orders/hydrateMarketState";
import {
  placeMakerLimitBuy,
  PostOnlyRejectionError,
} from "@alea/lib/trading/orders/placeMakerLimitBuy";
import { settleFilled } from "@alea/lib/trading/state/settleFilled";
import type { AssetSlot } from "@alea/lib/trading/state/types";
import { formatOrderError } from "@alea/lib/trading/telegram/formatOrderError";
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

/** Pause between placement attempts inside the retry loop. */
const PLACE_RETRY_DELAY_MS = 250;

/**
 * Stop the placement retry loop within this many ms of window close —
 * we'd cancel any new resting order almost immediately anyway.
 */
const PLACE_GIVE_UP_BEFORE_END_MS = ORDER_CANCEL_MARGIN_MS + 1_000;

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
  // Lifetime PnL accumulator. Single number across every window the
  // running process has summarized; resets on restart since the runner
  // is DB-free by design. Held in a one-field box so wrapUpWindow can
  // read-modify-write through a closure without TS narrowing it back
  // to a const-look-alike at every call site.
  const lifetimePnl: { value: number } = { value: 0 };

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
        rejectedCount: 0,
        placedAfterRetryCount: 0,
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
          lifetimePnl,
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
        // Mark slot non-empty synchronously so the next tick can't
        // re-fire placement while the async retry loop is in flight.
        record.slot = {
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
        void placeWithRetry({
          asset,
          client,
          record,
          window,
          lastTick,
          emas,
          books,
          table,
          minEdge,
          telegramBotToken,
          telegramChatId,
          signal,
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
  /**
   * postOnly rejections observed during this window — silent at the
   * time, surfaced in the per-window Telegram summary as
   * "Cross-book rejections: N".
   */
  rejectedCount: number;
  /**
   * Orders that eventually placed successfully after one or more
   * postOnly rejections (i.e. we re-evaluated against the moved book
   * and decided we still wanted in). Subset of "all orders placed".
   */
  placedAfterRetryCount: number;
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

/**
 * Places one maker-only limit BUY for `record`'s asset, with the
 * error-handling policy laid out in chunk-2 review:
 *
 *   - **postOnly rejection** (price moved between book read and post)
 *     is the expected friction of being a maker. Silent over Telegram.
 *     Increment `window.rejectedCount`. Re-fetch the book, re-evaluate
 *     the decision against the fresh state, and try again. Repeat
 *     until either we successfully place, the edge disappears, or the
 *     window-close margin is reached.
 *   - **Generic error** (network blip, signing hiccup, venue 5xx) gets
 *     one silent retry with the same parameters. If the retry also
 *     fails, fire-and-forget a Telegram alert (we want to know about
 *     these soon, but not at the cost of blocking the loop) and give
 *     up on this asset for the window.
 *
 * The slot is held in the `active` placeholder state for the entire
 * loop so the tick handler doesn't double-fire placement while we're
 * iterating.
 */
async function placeWithRetry({
  asset,
  client,
  record,
  window,
  lastTick,
  emas,
  books,
  table,
  minEdge,
  telegramBotToken,
  telegramChatId,
  signal,
  emit,
}: {
  readonly asset: Asset;
  readonly client: ClobClient;
  readonly record: AssetWindowRecord;
  readonly window: WindowRecord;
  readonly lastTick: ReadonlyMap<Asset, LivePriceTick>;
  readonly emas: ReadonlyMap<Asset, FiveMinuteEmaTracker>;
  readonly books: Map<Asset, UpDownBookSnapshot>;
  readonly table: ProbabilityTable;
  readonly minEdge: number;
  readonly telegramBotToken: string;
  readonly telegramChatId: string;
  readonly signal: AbortSignal;
  readonly emit: (event: LiveEvent) => void;
}): Promise<void> {
  let postOnlyRetries = 0;
  while (true) {
    if (signal.aborted) {
      record.slot = { kind: "empty" };
      return;
    }
    if (Date.now() >= window.windowEndMs - PLACE_GIVE_UP_BEFORE_END_MS) {
      record.slot = { kind: "empty" };
      return;
    }
    const market = record.market;
    if (market === null || !market.acceptingOrders) {
      record.slot = { kind: "empty" };
      return;
    }
    const decision = currentDecision({
      asset,
      record,
      window,
      lastTick,
      emas,
      books,
      table,
      minEdge,
    });
    if (decision === null) {
      record.slot = { kind: "empty" };
      return;
    }

    // Reflect the fresh decision in the placeholder slot so log/UI
    // events reading the slot mid-loop see the right side and price.
    record.slot = {
      kind: "active",
      market,
      side: decision.side,
      tokenId: decision.tokenId,
      orderId: null,
      limitPrice: decision.bid,
      sharesFilled: 0,
      costUsd: 0,
      feeRateBpsAvg: 0,
    };

    let attempt: PlaceAttempt = await attemptPlace({
      client,
      side: decision.side,
      tokenId: decision.tokenId,
      bid: decision.bid,
      negRisk: market.negRisk,
    });
    // One silent retry for generic errors with the same parameters.
    if (attempt.kind === "generic") {
      await sleep(PLACE_RETRY_DELAY_MS);
      attempt = await attemptPlace({
        client,
        side: decision.side,
        tokenId: decision.tokenId,
        bid: decision.bid,
        negRisk: market.negRisk,
      });
    }

    if (attempt.kind === "ok") {
      const placedSlot: Extract<AssetSlot, { kind: "active" }> = {
        kind: "active",
        market,
        side: attempt.placed.side,
        tokenId: attempt.placed.tokenId,
        orderId: attempt.placed.orderId,
        limitPrice: attempt.placed.limitPrice,
        sharesFilled: 0,
        costUsd: 0,
        feeRateBpsAvg: attempt.placed.feeRateBps,
      };
      record.slot = placedSlot;
      if (postOnlyRetries > 0) {
        window.placedAfterRetryCount += 1;
      }
      emit({
        kind: "order-placed",
        atMs: Date.now(),
        asset,
        slot: placedSlot,
      });
      const tick = lastTick.get(asset);
      const underlyingPrice =
        tick?.mid ?? record.line ?? attempt.placed.limitPrice;
      const linePrice = record.line ?? underlyingPrice;
      const message = formatOrderPlaced({
        asset,
        side: attempt.placed.side,
        stakeUsd: STAKE_USD,
        underlyingPrice,
        linePrice,
        windowEndMs: window.windowEndMs,
        nowMs: Date.now(),
      });
      sendTelegramFireAndForget({
        botToken: telegramBotToken,
        chatId: telegramChatId,
        text: message,
        emit,
        context: `${labelAsset(asset)} placement alert`,
      });
      return;
    }

    if (attempt.kind === "postOnly") {
      window.rejectedCount += 1;
      postOnlyRetries += 1;
      emit({
        kind: "info",
        atMs: Date.now(),
        message: `${labelAsset(asset)} postOnly rejection (#${postOnlyRetries}) at ${decision.bid.toFixed(2)} — ${attempt.errorMessage}`,
      });
      // Force a fresh book snapshot so the next pass evaluates against
      // the moved spread, not the stale poll. Best-effort; the loop
      // tolerates a failed refresh.
      try {
        const fresh = await fetchUpDownBook({ market, signal });
        books.set(asset, fresh);
      } catch {
        // Carry on with whatever the poll has.
      }
      await sleep(PLACE_RETRY_DELAY_MS);
      continue;
    }

    // Generic, after retry — give up and Telegram.
    record.slot = { kind: "empty" };
    emit({
      kind: "error",
      atMs: Date.now(),
      message: `${labelAsset(asset)} place failed (after retry): ${attempt.errorMessage}`,
    });
    sendTelegramFireAndForget({
      botToken: telegramBotToken,
      chatId: telegramChatId,
      text: formatOrderError({
        asset,
        side: decision.side,
        errorMessage: attempt.errorMessage,
      }),
      emit,
      context: `${labelAsset(asset)} order-error alert`,
    });
    return;
  }
}

type CurrentDecision = {
  readonly side: "up" | "down";
  readonly tokenId: string;
  readonly bid: number;
};

/**
 * Snapshots the live state into a single TAKE decision the placement
 * loop can act on, or `null` if any precondition is missing or the
 * edge has dropped below `minEdge` since last we looked.
 */
function currentDecision({
  asset,
  record,
  window,
  lastTick,
  emas,
  books,
  table,
  minEdge,
}: {
  readonly asset: Asset;
  readonly record: AssetWindowRecord;
  readonly window: WindowRecord;
  readonly lastTick: ReadonlyMap<Asset, LivePriceTick>;
  readonly emas: ReadonlyMap<Asset, FiveMinuteEmaTracker>;
  readonly books: ReadonlyMap<Asset, UpDownBookSnapshot>;
  readonly table: ProbabilityTable;
  readonly minEdge: number;
}): CurrentDecision | null {
  const market = record.market;
  if (market === null || record.line === null) {
    return null;
  }
  const tick = lastTick.get(asset);
  const tracker = emas.get(asset);
  if (tick === undefined || tracker === undefined) {
    return null;
  }
  const book = books.get(asset);
  const decision = evaluateDecision({
    asset,
    windowStartMs: window.windowStartMs,
    nowMs: Date.now(),
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
  if (decision.kind !== "trade" || decision.chosen.bid === null) {
    return null;
  }
  return {
    side: decision.chosen.side,
    tokenId: decision.chosen.tokenId,
    bid: decision.chosen.bid,
  };
}

type PlaceAttempt =
  | {
      readonly kind: "ok";
      readonly placed: Awaited<ReturnType<typeof placeMakerLimitBuy>>;
    }
  | { readonly kind: "postOnly"; readonly errorMessage: string }
  | { readonly kind: "generic"; readonly errorMessage: string };

async function attemptPlace({
  client,
  side,
  tokenId,
  bid,
  negRisk,
}: {
  readonly client: ClobClient;
  readonly side: "up" | "down";
  readonly tokenId: string;
  readonly bid: number;
  readonly negRisk: boolean;
}): Promise<PlaceAttempt> {
  try {
    const placed = await placeMakerLimitBuy({
      client,
      side,
      tokenId,
      limitPrice: bid,
      negRisk,
      feeRateBps: 0,
    });
    return { kind: "ok", placed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof PostOnlyRejectionError) {
      return { kind: "postOnly", errorMessage: message };
    }
    return { kind: "generic", errorMessage: message };
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Telegram is on the operator-experience hot path, not the trading
 * hot path. Send it without awaiting; surface failures as a `warn`
 * log line so the operator notices but the placement loop keeps
 * moving.
 */
function sendTelegramFireAndForget({
  botToken,
  chatId,
  text,
  emit,
  context,
}: {
  readonly botToken: string;
  readonly chatId: string;
  readonly text: string;
  readonly emit: (event: LiveEvent) => void;
  readonly context: string;
}): void {
  void sendTelegramMessage({ botToken, chatId, text }).catch((error) => {
    emit({
      kind: "warn",
      atMs: Date.now(),
      message: `${context} send failed: ${(error as Error).message}`,
    });
  });
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
  lifetimePnl,
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
  readonly lifetimePnl: { value: number };
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

  // Roll this window's PnL into the lifetime accumulator BEFORE we
  // format, so `Total Pnl` includes the latest window.
  const windowPnl = outcomes.reduce(
    (acc, o) => acc + (o.kind === "traded" ? o.netPnlUsd : 0),
    0,
  );
  lifetimePnl.value += windowPnl;

  const body = formatWindowSummary({
    outcomes,
    stats: {
      rejectedCount: window.rejectedCount,
      placedAfterRetryCount: window.placedAfterRetryCount,
    },
    totalPnlUsd: lifetimePnl.value,
  });
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
