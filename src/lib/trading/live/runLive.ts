import {
  ORDER_CANCEL_MARGIN_MS,
  STAKE_USD,
  WINDOW_SUMMARY_DELAY_MS,
} from "@alea/constants/trading";
import { streamBinancePerpLive } from "@alea/lib/livePrices/binancePerp/streamBinancePerpLive";
import {
  createFiveMinuteAtrTracker,
  type FiveMinuteAtrTracker,
} from "@alea/lib/livePrices/fiveMinuteAtrTracker";
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
import { evaluateDecision } from "@alea/lib/trading/decision/evaluateDecision";
import { applyFill } from "@alea/lib/trading/live/applyFill";
import { cancelResidualOrders } from "@alea/lib/trading/live/cancelResidualOrders";
import {
  atrReadyForWindow,
  emaReadyForWindow,
  tickCanCaptureLine,
  tickIsFresh,
  usableBookForMarket,
} from "@alea/lib/trading/live/freshness";
import { bootstrapLifetimePnl } from "@alea/lib/trading/live/lifetimePnlBootstrap";
import {
  hydrateAssetMarket,
  hydrateMovingTrackers,
} from "@alea/lib/trading/live/marketHydration";
import { placeWithRetry } from "@alea/lib/trading/live/placement";
import type {
  AssetWindowRecord,
  BookCache,
  ConditionIndex,
  LifetimePnlBox,
  LiveEvent,
  WindowRecord,
} from "@alea/lib/trading/live/types";
import { decimalsFor, labelAsset } from "@alea/lib/trading/live/utils";
import { wrapUpWindow } from "@alea/lib/trading/live/wrapUpWindow";
import type { ProbabilityTable } from "@alea/lib/trading/types";
import type {
  TradableMarket,
  UserStreamHandle,
  Vendor,
} from "@alea/lib/trading/vendor/types";
import type { Asset } from "@alea/types/assets";

const TICK_INTERVAL_MS = 250;
const BOOK_POLL_INTERVAL_MS = 1_500;

export type RunLiveParams = {
  readonly vendor: Vendor;
  readonly assets: readonly Asset[];
  readonly table: ProbabilityTable;
  readonly minEdge: number;
  readonly telegramBotToken: string;
  readonly telegramChatId: string;
  readonly emit: (event: LiveEvent) => void;
  readonly signal: AbortSignal;
};

/**
 * Long-running live trader. Vendor-agnostic — the orchestrator only
 * speaks to the venue through the `Vendor` interface, so swapping
 * Polymarket for Kalshi/Hyperliquid later is a new vendor module
 * plus the factory swap at the CLI layer.
 *
 * Concurrency invariants:
 *
 *   - Per asset, at most one open order *or* one position at a time.
 *     Enforced by the slot state machine: a new order is only placed
 *     when `slot.kind === "empty"`. The slot transitions atomically
 *     to `active` *before* the async placement call, so concurrent
 *     ticks can't double-fire.
 *   - Per window, the wrap-up timer fires exactly once at
 *     `windowEndMs + WINDOW_SUMMARY_DELAY_MS`. It cancels any still-
 *     resting orders, settles fills, builds the outcome list, and
 *     ships the Telegram summary.
 *   - In-memory state is per-window; a process restart re-hydrates
 *     each new window from `vendor.hydrateMarketState`. Lifetime PnL
 *     is the only persisted state (a checkpoint file under `tmp/`).
 *
 * The orchestrator does just three things:
 *   1. Boot — auth, lifetime-PnL hydration, EMA seed, Binance feed,
 *      user fill stream.
 *   2. Tick — every 250 ms, detect window rollover, capture lines,
 *      evaluate decisions, fire `placeWithRetry` for empty slots.
 *   3. Shutdown — clear timers, close streams.
 *
 * Everything else lives in the per-concern modules under `live/`.
 */
export async function runLive({
  vendor,
  assets,
  table,
  minEdge,
  telegramBotToken,
  telegramChatId,
  emit,
  signal,
}: RunLiveParams): Promise<void> {
  emit({
    kind: "info",
    atMs: Date.now(),
    message: `live trader starting: vendor=${vendor.id} assets=${assets.join(",")} stake=$${STAKE_USD} minEdge=${minEdge.toFixed(3)} wallet=${vendor.walletAddress.slice(0, 10)}…`,
  });

  const lifetimePnl: LifetimePnlBox = { value: 0 };
  await bootstrapLifetimePnl({ vendor, lifetimePnl, emit });
  if (signal.aborted) {
    return;
  }

  const emas = new Map<Asset, FiveMinuteEmaTracker>();
  const atrs = new Map<Asset, FiveMinuteAtrTracker>();
  for (const asset of assets) {
    emas.set(asset, createFiveMinuteEmaTracker());
    atrs.set(asset, createFiveMinuteAtrTracker());
  }
  await hydrateMovingTrackers({ assets, emas, atrs, signal, emit });
  if (signal.aborted) {
    return;
  }

  const lastTick = new Map<Asset, LivePriceTick>();
  const books: BookCache = new Map();
  const lastClosedBars = new Map<Asset, ClosedFiveMinuteBar>();
  const windows = new Map<number, WindowRecord>();
  const conditionIdIndex: ConditionIndex = new Map();

  const feedHandle = streamBinancePerpLive({
    assets,
    onTick: (tick) => {
      lastTick.set(tick.asset, tick);
    },
    onBarClose: (bar) => {
      lastClosedBars.set(bar.asset, bar);
      const ema = emas.get(bar.asset);
      const atr = atrs.get(bar.asset);
      const emaAccepted = ema !== undefined && ema.append(bar);
      const atrAccepted = atr !== undefined && atr.append(bar);
      if (emaAccepted || atrAccepted) {
        emit({
          kind: "info",
          atMs: Date.now(),
          message: `${labelAsset(bar.asset)} 5m close ${new Date(bar.openTimeMs).toISOString().slice(11, 16)} UTC: close=${bar.close}, ema50=${ema?.currentValue()?.toFixed(2) ?? "warming"}, atr14=${atr?.currentValue()?.toFixed(2) ?? "warming"}`,
        });
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

  // User-fill stream is rebuilt every time the active set of markets
  // changes (i.e. on each market discovery). Boxed handle so closure
  // mutations don't trip TS narrowing at the cleanup site.
  const userStreamBox: { handle: UserStreamHandle | null } = { handle: null };
  const restartUserStream = () => {
    const activeMarkets: TradableMarket[] = [];
    for (const w of windows.values()) {
      if (w.summarySent) {
        continue;
      }
      for (const r of w.perAsset.values()) {
        if (r.market !== null) {
          activeMarkets.push(r.market);
        }
      }
    }
    if (activeMarkets.length === 0) {
      return;
    }
    if (userStreamBox.handle !== null) {
      void userStreamBox.handle.stop();
      userStreamBox.handle = null;
    }
    userStreamBox.handle = vendor.streamUserFills({
      markets: activeMarkets,
      onFill: (fill) => {
        const indexed = conditionIdIndex.get(fill.vendorRef);
        if (indexed === undefined) {
          return;
        }
        const window = windows.get(indexed.windowStartMs);
        if (window === undefined) {
          return;
        }
        const record = window.perAsset.get(indexed.asset);
        if (record === undefined) {
          return;
        }
        applyFill({
          asset: indexed.asset,
          record,
          fill: {
            outcomeRef: fill.outcomeRef,
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
          message: `${vendor.id} user ws connected`,
        }),
      onDisconnect: (reason) =>
        emit({
          kind: "warn",
          atMs: Date.now(),
          message: `${vendor.id} user ws disconnected: ${reason}`,
        }),
      onError: (err) =>
        emit({
          kind: "error",
          atMs: Date.now(),
          message: `${vendor.id} user ws error: ${err.message}`,
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
        void refreshBook({ vendor, market, books, signal, emit });
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
      window = openNewWindow({
        startMs,
        assets,
      });
      windows.set(startMs, window);
      const justOpened = window;
      for (const asset of assets) {
        const record = justOpened.perAsset.get(asset);
        if (record === undefined) {
          continue;
        }
        void hydrateAssetMarket({
          asset,
          record,
          window: justOpened,
          vendor,
          conditionIdIndex,
          onSubscribe: restartUserStream,
          signal,
          emit,
        });
      }
      schedulePerWindowTimers({
        window: justOpened,
        nowMs,
        vendor,
        lastClosedBars,
        telegramBotToken,
        telegramChatId,
        windowsAll: windows,
        conditionIdIndex,
        lifetimePnl,
        walletAddress: vendor.walletAddress,
        emit,
      });
    }

    for (const asset of assets) {
      stepAsset({
        asset,
        record: window.perAsset.get(asset),
        window,
        nowMs,
        lastTick,
        emas,
        atrs,
        books,
        table,
        minEdge,
        vendor,
        telegramBotToken,
        telegramChatId,
        signal,
        emit,
      });
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
  if (userStreamBox.handle !== null) {
    await userStreamBox.handle.stop();
  }
  emit({ kind: "info", atMs: Date.now(), message: "live trader stopped" });
}

function openNewWindow({
  startMs,
  assets,
}: {
  readonly startMs: number;
  readonly assets: readonly Asset[];
}): WindowRecord {
  const record: WindowRecord = {
    windowStartMs: startMs,
    windowEndMs: startMs + FIVE_MINUTES_MS,
    perAsset: new Map(),
    summarySent: false,
    cancelTimer: null,
    wrapUpTimer: null,
    rejectedCount: 0,
    placedAfterRetryCount: 0,
    settlementRetryCount: 0,
  };
  for (const asset of assets) {
    record.perAsset.set(asset, {
      asset,
      market: null,
      hydrationStatus: "pending",
      line: null,
      lineCapturedAtMs: null,
      lastDecisionRemaining: null,
      slot: { kind: "empty" },
    });
  }
  return record;
}

function schedulePerWindowTimers({
  window,
  nowMs,
  vendor,
  lastClosedBars,
  telegramBotToken,
  telegramChatId,
  windowsAll,
  conditionIdIndex,
  lifetimePnl,
  walletAddress,
  emit,
}: {
  readonly window: WindowRecord;
  readonly nowMs: number;
  readonly vendor: Vendor;
  readonly lastClosedBars: Map<Asset, ClosedFiveMinuteBar>;
  readonly telegramBotToken: string;
  readonly telegramChatId: string;
  readonly windowsAll: Map<number, WindowRecord>;
  readonly conditionIdIndex: ConditionIndex;
  readonly lifetimePnl: LifetimePnlBox;
  readonly walletAddress: string;
  readonly emit: (event: LiveEvent) => void;
}): void {
  const cancelAtMs = window.windowEndMs - ORDER_CANCEL_MARGIN_MS;
  const wrapUpAtMs = window.windowEndMs + WINDOW_SUMMARY_DELAY_MS;
  window.cancelTimer = setTimeout(
    () => {
      window.cancelTimer = null;
      void cancelResidualOrders({ window, vendor, emit });
    },
    Math.max(0, cancelAtMs - nowMs),
  );
  window.wrapUpTimer = setTimeout(
    () => {
      window.wrapUpTimer = null;
      void wrapUpWindow({
        window,
        lastClosedBars,
        telegramBotToken,
        telegramChatId,
        windowsAll,
        conditionIdIndex,
        lifetimePnl,
        walletAddress,
        emit,
      });
    },
    Math.max(0, wrapUpAtMs - nowMs),
  );
}

function stepAsset({
  asset,
  record,
  window,
  nowMs,
  lastTick,
  emas,
  atrs,
  books,
  table,
  minEdge,
  vendor,
  telegramBotToken,
  telegramChatId,
  signal,
  emit,
}: {
  readonly asset: Asset;
  readonly record: AssetWindowRecord | undefined;
  readonly window: WindowRecord;
  readonly nowMs: number;
  readonly lastTick: ReadonlyMap<Asset, LivePriceTick>;
  readonly emas: ReadonlyMap<Asset, FiveMinuteEmaTracker>;
  readonly atrs: ReadonlyMap<Asset, FiveMinuteAtrTracker>;
  readonly books: BookCache;
  readonly table: ProbabilityTable;
  readonly minEdge: number;
  readonly vendor: Vendor;
  readonly telegramBotToken: string;
  readonly telegramChatId: string;
  readonly signal: AbortSignal;
  readonly emit: (event: LiveEvent) => void;
}): void {
  if (record === undefined) {
    return;
  }
  // Capture the line on the first tick we see in this window.
  if (record.line === null) {
    const tick = lastTick.get(asset);
    if (
      tick !== undefined &&
      tickCanCaptureLine({ tick, windowStartMs: window.windowStartMs, nowMs })
    ) {
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
  // Re-evaluate when the bucket flips OR while the slot is still
  // empty (covers the case where market discovery / book hydration
  // completes mid-bucket). Once the slot is non-empty for this
  // window we stop re-evaluating.
  const bucketChanged = remaining !== record.lastDecisionRemaining;
  const slotEmpty = record.slot.kind === "empty";
  if (remaining === null) {
    record.lastDecisionRemaining = null;
    return;
  }
  if (!bucketChanged && !slotEmpty) {
    return;
  }

  const tick = lastTick.get(asset);
  const tracker = emas.get(asset);
  const atrTracker = atrs.get(asset);
  const market = record.market;
  if (
    tick === undefined ||
    tracker === undefined ||
    atrTracker === undefined ||
    market === null ||
    record.hydrationStatus !== "ready" ||
    record.line === null
  ) {
    return;
  }
  if (!tickIsFresh({ tick, windowStartMs: window.windowStartMs, nowMs })) {
    return;
  }
  const ema50 = emaReadyForWindow({
    tracker,
    windowStartMs: window.windowStartMs,
  });
  if (ema50 === null) {
    return;
  }
  const atr14 = atrReadyForWindow({
    tracker: atrTracker,
    windowStartMs: window.windowStartMs,
  });
  if (atr14 === null) {
    return;
  }
  const book = usableBookForMarket({
    book: books.get(market.vendorRef),
    vendorRef: market.vendorRef,
    windowStartMs: market.windowStartMs,
    nowMs,
  });
  const decision = evaluateDecision({
    asset,
    windowStartMs: window.windowStartMs,
    nowMs,
    line: record.line,
    currentPrice: tick.mid,
    ema50,
    atr14,
    upBestBid: book?.up.bestBid ?? null,
    downBestBid: book?.down.bestBid ?? null,
    upTokenId: market.upRef,
    downTokenId: market.downRef,
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
      outcomeRef: decision.chosen.tokenId,
      orderId: null,
      limitPrice: decision.chosen.bid ?? 0,
      sharesIfFilled: 0,
      sharesFilled: 0,
      costUsd: 0,
      feesUsd: 0,
      feeRateBpsAvg: 0,
    };
    void placeWithRetry({
      asset,
      vendor,
      record,
      window,
      lastTick,
      emas,
      atrs,
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

async function refreshBook({
  vendor,
  market,
  books,
  signal,
  emit,
}: {
  readonly vendor: Vendor;
  readonly market: TradableMarket;
  readonly books: BookCache;
  readonly signal: AbortSignal;
  readonly emit: (event: LiveEvent) => void;
}): Promise<void> {
  try {
    books.set(market.vendorRef, await vendor.fetchBook({ market, signal }));
  } catch (error) {
    emit({
      kind: "warn",
      atMs: Date.now(),
      message: `${labelAsset(market.asset)} book refresh failed: ${(error as Error).message}`,
    });
  }
}
