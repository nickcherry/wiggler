import {
  EMA50_BOOTSTRAP_BARS,
  ORDER_CANCEL_MARGIN_MS,
  STAKE_USD,
  WINDOW_SUMMARY_DELAY_MS,
} from "@alea/constants/trading";
import { binancePerpLivePriceSource } from "@alea/lib/livePrices/binancePerp/source";
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
import type { LivePriceSource } from "@alea/lib/livePrices/source";
import type {
  ClosedFiveMinuteBar,
  LivePriceTick,
} from "@alea/lib/livePrices/types";
import {
  applyTradeToSimulatedOrder,
  createSimulatedDryOrder,
  type SimulatedDryOrder,
} from "@alea/lib/trading/dryRun/fillSimulation";
import {
  createDryTradingJsonlWriter,
  type DryTradingJsonlWriter,
} from "@alea/lib/trading/dryRun/jsonlLog";
import {
  computeDryAggregateMetrics,
  type DryOrderResolution,
} from "@alea/lib/trading/dryRun/metrics";
import type { DryRunEvent } from "@alea/lib/trading/dryRun/types";
import { evaluateRecordDecision } from "@alea/lib/trading/live/evaluateRecordDecision";
import { tickCanCaptureLine } from "@alea/lib/trading/live/freshness";
import type {
  AssetWindowRecord,
  BookCache,
  WindowRecord,
} from "@alea/lib/trading/live/types";
import { decimalsFor, labelAsset } from "@alea/lib/trading/live/utils";
import type { ProbabilityTable } from "@alea/lib/trading/types";
import type {
  MarketDataEvent,
  MarketDataResolvedEvent,
  MarketDataStreamHandle,
  PreparedMakerLimitOrder,
  PriceLevel,
  TradableMarket,
  UpDownBook,
  Vendor,
} from "@alea/lib/trading/vendor/types";
import type { Asset } from "@alea/types/assets";

const BOOK_POLL_INTERVAL_MS = 2_000;
const TICK_INTERVAL_MS = 250;
const GTD_MIN_VALIDITY_BUFFER_MS = 61_000;
const PLACE_GIVE_UP_BEFORE_END_MS =
  ORDER_CANCEL_MARGIN_MS + GTD_MIN_VALIDITY_BUFFER_MS;
const OFFICIAL_RESOLUTION_RETRY_MS = 5_000;

export type DryRunParams = {
  readonly vendor: Vendor;
  readonly assets: readonly Asset[];
  readonly table: ProbabilityTable;
  readonly minEdge: number;
  readonly priceSource?: LivePriceSource;
  readonly logWriter?: DryTradingJsonlWriter;
  readonly emit: (event: DryRunEvent) => void;
  readonly signal: AbortSignal;
};

/**
 * Long-running dry trader. It shares the live runner's decision and
 * order-preparation path, then swaps the money-touching placement for
 * a queue-aware fill simulator fed by Polymarket's public market WS.
 */
export async function runDryRun({
  vendor,
  assets,
  table,
  minEdge,
  priceSource = binancePerpLivePriceSource,
  logWriter,
  emit,
  signal,
}: DryRunParams): Promise<void> {
  const writer = logWriter ?? (await createDryTradingJsonlWriter());
  const caps = requireDryRunCapabilities({ vendor });

  const emas = new Map<Asset, FiveMinuteEmaTracker>();
  const atrs = new Map<Asset, FiveMinuteAtrTracker>();
  const lastTick = new Map<Asset, LivePriceTick>();
  const lastClosedBars = new Map<Asset, ClosedFiveMinuteBar>();
  const books: BookCache = new Map();
  const windows = new Map<number, DryWindowState>();
  const tokenIndex = new Map<string, { asset: Asset; windowStartMs: number }>();
  const marketIndex = new Map<string, { asset: Asset; windowStartMs: number }>();
  const finalizedResolutions: DryOrderResolution[] = [];

  await writer.append({
    type: "session_start",
    atMs: Date.now(),
    config: {
      vendor: vendor.id,
      priceSource: priceSource.id,
      assets,
      minEdge,
      stakeUsd: STAKE_USD,
      tableRange: formatTableRange({ table }),
    },
  });

  emit({
    kind: "info",
    atMs: Date.now(),
    message: `dry-trading starting: vendor=${vendor.id} priceSource=${priceSource.id} assets=${assets.join(",")} stake=$${STAKE_USD} minEdge=${minEdge.toFixed(3)} log=${writer.path}`,
  });

  for (const asset of assets) {
    emas.set(asset, createFiveMinuteEmaTracker());
    atrs.set(asset, createFiveMinuteAtrTracker());
  }
  await hydrateTrackers({
    assets,
    emas,
    atrs,
    priceSource,
    signal,
    emit,
  });
  if (signal.aborted) {
    return;
  }

  const priceFeedHandle = priceSource.stream({
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
          message: `${labelAsset(bar.asset)} 5m close ${new Date(bar.openTimeMs).toISOString().slice(11, 16)} UTC: close=${bar.close}, ema50=${ema?.currentValue()?.toFixed(2) ?? "warming"}, atr=${atr?.currentValue()?.toFixed(2) ?? "warming"}`,
        });
      }
    },
    onConnect: () =>
      emit({
        kind: "info",
        atMs: Date.now(),
        message: `${priceSource.id} ws connected`,
      }),
    onDisconnect: (reason) =>
      emit({
        kind: "warn",
        atMs: Date.now(),
        message: `${priceSource.id} ws disconnected: ${reason}`,
      }),
    onError: (error) =>
      emit({
        kind: "error",
        atMs: Date.now(),
        message: `${priceSource.id} ws error: ${error.message}`,
      }),
  });

  const marketStreamBox: { handle: MarketDataStreamHandle | null } = {
    handle: null,
  };
  const restartMarketStream = () => {
    const activeMarkets = activeDryMarkets({ windows });
    if (activeMarkets.length === 0) {
      return;
    }
    if (marketStreamBox.handle !== null) {
      void marketStreamBox.handle.stop();
      marketStreamBox.handle = null;
    }
    marketStreamBox.handle = caps.streamMarketData({
      markets: activeMarkets,
      onEvent: (event) => {
        handleMarketDataEvent({
          event,
          windows,
          books,
          tokenIndex,
          marketIndex,
          finalizedResolutions,
          writer,
          emit,
          caps,
          priceSource,
          signal,
        });
      },
      onConnect: () =>
        emit({
          kind: "info",
          atMs: Date.now(),
          message: `${vendor.id} market ws connected`,
        }),
      onDisconnect: (reason) =>
        emit({
          kind: "warn",
          atMs: Date.now(),
          message: `${vendor.id} market ws disconnected: ${reason}`,
        }),
      onError: (error) =>
        emit({
          kind: "error",
          atMs: Date.now(),
          message: `${vendor.id} market ws error: ${error.message}`,
        }),
    });
  };

  const bookPollTimer = setInterval(() => {
    if (signal.aborted) {
      return;
    }
    for (const state of windows.values()) {
      if (state.finalized) {
        continue;
      }
      for (const assetState of state.perAsset.values()) {
        const market = assetState.record.market;
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
    let state = windows.get(startMs);
    if (state === undefined) {
      state = openDryWindow({ startMs, assets });
      windows.set(startMs, state);
      for (const asset of assets) {
        const assetState = state.perAsset.get(asset);
        if (assetState === undefined) {
          continue;
        }
        void hydrateDryAssetMarket({
          asset,
          state,
          assetState,
          vendor,
          tokenIndex,
          marketIndex,
          restartMarketStream,
          signal,
          emit,
        });
      }
      scheduleDryWindowCheckpoint({
        state,
        nowMs,
        caps,
        priceSource,
        lastClosedBars,
        finalizedResolutions,
        writer,
        signal,
        emit,
      });
    }

    for (const asset of assets) {
      const assetState = state.perAsset.get(asset);
      if (assetState === undefined) {
        continue;
      }
      stepDryAsset({
        asset,
        state,
        assetState,
        vendor,
        lastTick,
        emas,
        atrs,
        books,
        table,
        minEdge,
        writer,
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
  for (const state of windows.values()) {
    if (state.checkpointTimer !== null) {
      clearTimeout(state.checkpointTimer);
    }
    if (state.finalizeRetryTimer !== null) {
      clearTimeout(state.finalizeRetryTimer);
    }
  }
  await priceFeedHandle.stop();
  if (marketStreamBox.handle !== null) {
    await marketStreamBox.handle.stop();
  }
  await writer.append({
    type: "session_stop",
    atMs: Date.now(),
    summary: {
      finalizedWindows: [...windows.values()].filter((w) => w.finalized).length,
      pendingWindows: [...windows.values()].filter((w) => !w.finalized).length,
      sessionMetrics: computeDryAggregateMetrics({
        resolutions: finalizedResolutions,
      }),
    },
  });
  emit({ kind: "info", atMs: Date.now(), message: "dry-trading stopped" });
}

type DryVendorCapabilities = {
  readonly prepareMakerLimitBuy: NonNullable<Vendor["prepareMakerLimitBuy"]>;
  readonly streamMarketData: NonNullable<Vendor["streamMarketData"]>;
  readonly resolveMarketOutcome: NonNullable<Vendor["resolveMarketOutcome"]>;
};

type DryWindowState = {
  readonly window: WindowRecord;
  readonly perAsset: Map<Asset, DryAssetState>;
  checkpointTimer: ReturnType<typeof setTimeout> | null;
  finalizeRetryTimer: ReturnType<typeof setTimeout> | null;
  checkpointAppended: boolean;
  finalized: boolean;
  finalizing: boolean;
};

type DryAssetState = {
  readonly record: AssetWindowRecord;
  readonly decisionsByRemaining: Map<number, ReturnType<typeof evaluateRecordDecision>>;
  order: DryOrderEnvelope | null;
  proxyOutcome: DryProxyOutcome | null;
  officialOutcome: "up" | "down" | null;
  officialResolvedAtMs: number | null;
  officialPendingReason: string | null;
};

type DryOrderEnvelope = {
  readonly order: SimulatedDryOrder;
  readonly prepared: PreparedMakerLimitOrder;
  readonly decision: Extract<
    NonNullable<ReturnType<typeof evaluateRecordDecision>>,
    { kind: "trade" }
  >;
  readonly entryPrice: number;
  readonly line: number;
  readonly upBestBid: number | null;
  readonly upBestAsk: number | null;
  readonly downBestBid: number | null;
  readonly downBestAsk: number | null;
  readonly spread: number | null;
};

type DryProxyOutcome = {
  readonly winningSide: "up" | "down";
  readonly line: number;
  readonly close: number;
  readonly closeTimeMs: number;
};

function requireDryRunCapabilities({
  vendor,
}: {
  readonly vendor: Vendor;
}): DryVendorCapabilities {
  if (
    vendor.prepareMakerLimitBuy === undefined ||
    vendor.streamMarketData === undefined ||
    vendor.resolveMarketOutcome === undefined
  ) {
    throw new Error(
      `${vendor.id} vendor does not implement dry-run market-data/order-prep capabilities.`,
    );
  }
  return {
    prepareMakerLimitBuy: vendor.prepareMakerLimitBuy.bind(vendor),
    streamMarketData: vendor.streamMarketData.bind(vendor),
    resolveMarketOutcome: vendor.resolveMarketOutcome.bind(vendor),
  };
}

async function hydrateTrackers({
  assets,
  emas,
  atrs,
  priceSource,
  signal,
  emit,
}: {
  readonly assets: readonly Asset[];
  readonly emas: Map<Asset, FiveMinuteEmaTracker>;
  readonly atrs: Map<Asset, FiveMinuteAtrTracker>;
  readonly priceSource: LivePriceSource;
  readonly signal: AbortSignal;
  readonly emit: (event: DryRunEvent) => void;
}): Promise<void> {
  for (const asset of assets) {
    if (signal.aborted) {
      return;
    }
    try {
      const bars = await priceSource.fetchRecentFiveMinuteBars({
        asset,
        count: EMA50_BOOTSTRAP_BARS,
        signal,
      });
      const ema = emas.get(asset);
      const atr = atrs.get(asset);
      for (const bar of bars) {
        ema?.append(bar);
        atr?.append(bar);
      }
      emit({
        kind: "info",
        atMs: Date.now(),
        message: `${labelAsset(asset)} hydrated ${bars.length} closed 5m bars, ema50=${ema?.currentValue()?.toFixed(2) ?? "warming"}, atr=${atr?.currentValue()?.toFixed(2) ?? "warming"}`,
      });
    } catch (error) {
      emit({
        kind: "warn",
        atMs: Date.now(),
        message: `${labelAsset(asset)} bootstrap failed: ${(error as Error).message}`,
      });
    }
  }
}

function openDryWindow({
  startMs,
  assets,
}: {
  readonly startMs: number;
  readonly assets: readonly Asset[];
}): DryWindowState {
  const window: WindowRecord = {
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
  const perAsset = new Map<Asset, DryAssetState>();
  for (const asset of assets) {
    const record: AssetWindowRecord = {
      asset,
      market: null,
      hydrationStatus: "pending",
      line: null,
      lineCapturedAtMs: null,
      lastDecisionRemaining: null,
      slot: { kind: "empty" },
    };
    window.perAsset.set(asset, record);
    perAsset.set(asset, {
      record,
      decisionsByRemaining: new Map(),
      order: null,
      proxyOutcome: null,
      officialOutcome: null,
      officialResolvedAtMs: null,
      officialPendingReason: null,
    });
  }
  return {
    window,
    perAsset,
    checkpointTimer: null,
    finalizeRetryTimer: null,
    checkpointAppended: false,
    finalized: false,
    finalizing: false,
  };
}

async function hydrateDryAssetMarket({
  asset,
  state,
  assetState,
  vendor,
  tokenIndex,
  marketIndex,
  restartMarketStream,
  signal,
  emit,
}: {
  readonly asset: Asset;
  readonly state: DryWindowState;
  readonly assetState: DryAssetState;
  readonly vendor: Vendor;
  readonly tokenIndex: Map<string, { asset: Asset; windowStartMs: number }>;
  readonly marketIndex: Map<string, { asset: Asset; windowStartMs: number }>;
  readonly restartMarketStream: () => void;
  readonly signal: AbortSignal;
  readonly emit: (event: DryRunEvent) => void;
}): Promise<void> {
  try {
    const market = await vendor.discoverMarket({
      asset,
      windowStartUnixSeconds: Math.floor(state.window.windowStartMs / 1000),
      signal,
    });
    if (market === null) {
      assetState.record.hydrationStatus = "failed";
      emit({
        kind: "warn",
        atMs: Date.now(),
        message: `${labelAsset(asset)} no ${vendor.id} market for window ${new Date(state.window.windowStartMs).toISOString().slice(11, 16)}`,
      });
      return;
    }
    assetState.record.market = market;
    assetState.record.hydrationStatus = "ready";
    tokenIndex.set(market.upRef, { asset, windowStartMs: state.window.windowStartMs });
    tokenIndex.set(market.downRef, { asset, windowStartMs: state.window.windowStartMs });
    marketIndex.set(market.vendorRef, {
      asset,
      windowStartMs: state.window.windowStartMs,
    });
    restartMarketStream();
    emit({
      kind: "info",
      atMs: Date.now(),
      message: `${labelAsset(asset)} discovered ${market.displayLabel ?? market.vendorRef}, accepting=${market.acceptingOrders}`,
    });
  } catch (error) {
    assetState.record.hydrationStatus = "failed";
    emit({
      kind: "error",
      atMs: Date.now(),
      message: `${labelAsset(asset)} market discovery failed: ${(error as Error).message}`,
    });
  }
}

function stepDryAsset({
  asset,
  state,
  assetState,
  vendor,
  lastTick,
  emas,
  atrs,
  books,
  table,
  minEdge,
  writer,
  signal,
  emit,
}: {
  readonly asset: Asset;
  readonly state: DryWindowState;
  readonly assetState: DryAssetState;
  readonly vendor: Vendor;
  readonly lastTick: ReadonlyMap<Asset, LivePriceTick>;
  readonly emas: ReadonlyMap<Asset, FiveMinuteEmaTracker>;
  readonly atrs: ReadonlyMap<Asset, FiveMinuteAtrTracker>;
  readonly books: BookCache;
  readonly table: ProbabilityTable;
  readonly minEdge: number;
  readonly writer: DryTradingJsonlWriter;
  readonly signal: AbortSignal;
  readonly emit: (event: DryRunEvent) => void;
}): void {
  const { record } = assetState;
  const nowMs = Date.now();
  if (record.line === null) {
    const tick = lastTick.get(asset);
    if (
      tick !== undefined &&
      tickCanCaptureLine({
        tick,
        windowStartMs: state.window.windowStartMs,
        nowMs,
      })
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
    windowStartMs: state.window.windowStartMs,
    nowMs,
  });
  if (remaining === null) {
    record.lastDecisionRemaining = null;
    return;
  }
  const bucketChanged = remaining !== record.lastDecisionRemaining;
  const slotEmpty = assetState.order === null && record.slot.kind === "empty";
  if (!bucketChanged && !slotEmpty) {
    return;
  }

  const decision = evaluateRecordDecision({
    asset,
    record,
    window: state.window,
    lastTick,
    emas,
    atrs,
    books,
    table,
    minEdge,
    nowMs,
  });
  if (decision === null) {
    return;
  }
  if (bucketChanged) {
    record.lastDecisionRemaining = remaining;
    assetState.decisionsByRemaining.set(remaining, decision);
    emit({ kind: "decision", atMs: nowMs, decision });
  }
  if (
    decision.kind === "trade" &&
    assetState.order === null &&
    record.slot.kind === "empty" &&
    record.market !== null &&
    record.market.acceptingOrders
  ) {
    record.slot = {
      kind: "active",
      market: record.market,
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
    void prepareDryOrder({
      asset,
      state,
      assetState,
      vendor,
      lastTick,
      emas,
      atrs,
      books,
      table,
      minEdge,
      writer,
      signal,
      emit,
    });
  }
}

async function prepareDryOrder({
  asset,
  state,
  assetState,
  vendor,
  lastTick,
  emas,
  atrs,
  books,
  table,
  minEdge,
  writer,
  signal,
  emit,
}: {
  readonly asset: Asset;
  readonly state: DryWindowState;
  readonly assetState: DryAssetState;
  readonly vendor: Vendor;
  readonly lastTick: ReadonlyMap<Asset, LivePriceTick>;
  readonly emas: ReadonlyMap<Asset, FiveMinuteEmaTracker>;
  readonly atrs: ReadonlyMap<Asset, FiveMinuteAtrTracker>;
  readonly books: BookCache;
  readonly table: ProbabilityTable;
  readonly minEdge: number;
  readonly writer: DryTradingJsonlWriter;
  readonly signal: AbortSignal;
  readonly emit: (event: DryRunEvent) => void;
}): Promise<void> {
  const record = assetState.record;
  if (
    signal.aborted ||
    Date.now() >= state.window.windowEndMs - PLACE_GIVE_UP_BEFORE_END_MS ||
    record.market === null ||
    vendor.prepareMakerLimitBuy === undefined
  ) {
    record.slot = { kind: "empty" };
    return;
  }
  let fresh: UpDownBook;
  try {
    fresh = await vendor.fetchBook({ market: record.market, signal });
    books.set(fresh.market.vendorRef, fresh);
    record.market = fresh.market;
  } catch (error) {
    record.slot = { kind: "empty" };
    emit({
      kind: "warn",
      atMs: Date.now(),
      message: `${labelAsset(asset)} dry JIT book refresh failed: ${(error as Error).message}`,
    });
    return;
  }
  const decision = evaluateRecordDecision({
    asset,
    record,
    window: state.window,
    lastTick,
    emas,
    atrs,
    books,
    table,
    minEdge,
    nowMs: Date.now(),
  });
  if (
    decision === null ||
    decision.kind !== "trade" ||
    decision.chosen.bid === null
  ) {
    record.slot = { kind: "empty" };
    return;
  }
  const prepared = await vendor.prepareMakerLimitBuy({
    market: fresh.market,
    side: decision.chosen.side,
    limitPrice: decision.chosen.bid,
    stakeUsd: STAKE_USD,
    expireBeforeMs: state.window.windowEndMs - ORDER_CANCEL_MARGIN_MS,
  });
  if (prepared.expiresAtMs === null) {
    record.slot = { kind: "empty" };
    return;
  }
  const tick = lastTick.get(asset);
  const line = record.line;
  if (tick === undefined || line === null) {
    record.slot = { kind: "empty" };
    return;
  }
  const queueAheadShares = queueAheadAtLimit({
    book: fresh,
    side: prepared.side,
    limitPrice: prepared.limitPrice,
  });
  const order = createSimulatedDryOrder({
    id: `dry-${fresh.market.vendorRef}-${prepared.outcomeRef}-${prepared.preparedAtMs}`,
    asset,
    windowStartMs: state.window.windowStartMs,
    windowEndMs: state.window.windowEndMs,
    vendorRef: fresh.market.vendorRef,
    outcomeRef: prepared.outcomeRef,
    side: prepared.side,
    limitPrice: prepared.limitPrice,
    sharesIfFilled: prepared.sharesIfFilled,
    placedAtMs: prepared.preparedAtMs,
    expiresAtMs: prepared.expiresAtMs,
    queueAheadShares,
  });
  const top = topForSide({ book: fresh, side: prepared.side });
  assetState.order = {
    order,
    prepared,
    decision,
    entryPrice: tick.mid,
    line,
    upBestBid: fresh.up.bestBid,
    upBestAsk: fresh.up.bestAsk,
    downBestBid: fresh.down.bestBid,
    downBestAsk: fresh.down.bestAsk,
    spread:
      top.bestBid === null || top.bestAsk === null
        ? null
        : top.bestAsk - top.bestBid,
  };
  record.slot = {
    kind: "active",
    market: fresh.market,
    side: prepared.side,
    outcomeRef: prepared.outcomeRef,
    orderId: order.id,
    limitPrice: prepared.limitPrice,
    sharesIfFilled: prepared.sharesIfFilled,
    sharesFilled: 0,
    costUsd: 0,
    feesUsd: 0,
    feeRateBpsAvg: 0,
  };
  emit({ kind: "virtual-order", atMs: Date.now(), asset, order });
  await writer.append({
    type: "virtual_order",
    atMs: Date.now(),
    order: serializeDryOrder({ envelope: assetState.order }),
  });
}

function handleMarketDataEvent({
  event,
  windows,
  books,
  tokenIndex,
  marketIndex,
  finalizedResolutions,
  writer,
  emit,
  caps,
  priceSource,
  signal,
}: {
  readonly event: MarketDataEvent;
  readonly windows: Map<number, DryWindowState>;
  readonly books: BookCache;
  readonly tokenIndex: ReadonlyMap<string, { asset: Asset; windowStartMs: number }>;
  readonly marketIndex: ReadonlyMap<string, { asset: Asset; windowStartMs: number }>;
  readonly finalizedResolutions: DryOrderResolution[];
  readonly writer: DryTradingJsonlWriter;
  readonly emit: (event: DryRunEvent) => void;
  readonly caps: DryVendorCapabilities;
  readonly priceSource: LivePriceSource;
  readonly signal: AbortSignal;
}): void {
  if (event.kind === "book" || event.kind === "best-bid-ask") {
    applyBookEvent({ event, windows, books, tokenIndex });
    return;
  }
  if (event.kind === "resolved") {
    applyResolvedEvent({ event, windows, marketIndex });
    const indexed = marketIndex.get(event.vendorRef);
    if (indexed !== undefined) {
      const state = windows.get(indexed.windowStartMs);
      if (state !== undefined) {
        void finalizeDryWindow({
          state,
          caps,
          priceSource,
          finalizedResolutions,
          writer,
          signal,
          emit,
          appendCheckpointIfPending: false,
        });
      }
    }
    return;
  }
  if (event.kind !== "trade") {
    return;
  }
  const indexed = tokenIndex.get(event.outcomeRef);
  if (indexed === undefined) {
    return;
  }
  const state = windows.get(indexed.windowStartMs);
  const assetState = state?.perAsset.get(indexed.asset);
  const envelope = assetState?.order;
  if (
    state === undefined ||
    assetState === undefined ||
    envelope === undefined ||
    envelope === null
  ) {
    return;
  }
  const before = envelope.order.canonicalFilledShares;
  const changed = applyTradeToSimulatedOrder({
    order: envelope.order,
    trade: event,
  });
  if (!changed) {
    return;
  }
  if (assetState.record.slot.kind === "active") {
    assetState.record.slot = {
      ...assetState.record.slot,
      sharesFilled: envelope.order.canonicalFilledShares,
      costUsd: envelope.order.canonicalCostUsd,
      orderId:
        envelope.order.canonicalFilledShares >= envelope.order.sharesIfFilled
          ? null
          : envelope.order.id,
    };
  }
  if (envelope.order.canonicalFilledShares > before) {
    emit({
      kind: "virtual-fill",
      atMs: event.atMs,
      asset: indexed.asset,
      order: envelope.order,
    });
  }
}

function applyBookEvent({
  event,
  windows,
  books,
  tokenIndex,
}: {
  readonly event: Extract<MarketDataEvent, { kind: "book" | "best-bid-ask" }>;
  readonly windows: ReadonlyMap<number, DryWindowState>;
  readonly books: BookCache;
  readonly tokenIndex: ReadonlyMap<string, { asset: Asset; windowStartMs: number }>;
}): void {
  const indexed = tokenIndex.get(event.outcomeRef);
  if (indexed === undefined) {
    return;
  }
  const state = windows.get(indexed.windowStartMs);
  const market = state?.perAsset.get(indexed.asset)?.record.market;
  if (state === undefined || market === undefined || market === null) {
    return;
  }
  const existing =
    books.get(market.vendorRef) ??
    ({
      market,
      up: { bestBid: null, bestAsk: null },
      down: { bestBid: null, bestAsk: null },
      fetchedAtMs: event.atMs,
    } satisfies UpDownBook);
  const side = event.outcomeRef === market.upRef ? "up" : "down";
  const top =
    event.kind === "book"
      ? {
          bestBid: bestFromLevels({ levels: event.bids, side: "bid" }),
          bestAsk: bestFromLevels({ levels: event.asks, side: "ask" }),
          bidLevels: event.bids,
          askLevels: event.asks,
        }
      : {
          ...existing[side],
          bestBid: event.bestBid,
          bestAsk: event.bestAsk,
        };
  books.set(market.vendorRef, {
    ...existing,
    [side]: top,
    fetchedAtMs: event.atMs,
  });
}

function applyResolvedEvent({
  event,
  windows,
  marketIndex,
}: {
  readonly event: MarketDataResolvedEvent;
  readonly windows: ReadonlyMap<number, DryWindowState>;
  readonly marketIndex: ReadonlyMap<string, { asset: Asset; windowStartMs: number }>;
}): void {
  const indexed = marketIndex.get(event.vendorRef);
  if (indexed === undefined || event.winningSide === null) {
    return;
  }
  const state = windows.get(indexed.windowStartMs);
  const assetState = state?.perAsset.get(indexed.asset);
  if (assetState === undefined) {
    return;
  }
  assetState.officialOutcome = event.winningSide;
  assetState.officialResolvedAtMs = event.atMs;
  assetState.officialPendingReason = null;
}

function scheduleDryWindowCheckpoint({
  state,
  nowMs,
  caps,
  priceSource,
  lastClosedBars,
  finalizedResolutions,
  writer,
  signal,
  emit,
}: {
  readonly state: DryWindowState;
  readonly nowMs: number;
  readonly caps: DryVendorCapabilities;
  readonly priceSource: LivePriceSource;
  readonly lastClosedBars: Map<Asset, ClosedFiveMinuteBar>;
  readonly finalizedResolutions: DryOrderResolution[];
  readonly writer: DryTradingJsonlWriter;
  readonly signal: AbortSignal;
  readonly emit: (event: DryRunEvent) => void;
}): void {
  const checkpointAtMs = state.window.windowEndMs + WINDOW_SUMMARY_DELAY_MS;
  state.checkpointTimer = setTimeout(
    () => {
      state.checkpointTimer = null;
      void finalizeDryWindow({
        state,
        caps,
        priceSource,
        lastClosedBars,
        finalizedResolutions,
        writer,
        signal,
        emit,
        appendCheckpointIfPending: true,
      });
    },
    Math.max(0, checkpointAtMs - nowMs),
  );
}

async function finalizeDryWindow({
  state,
  caps,
  priceSource,
  lastClosedBars,
  finalizedResolutions,
  writer,
  signal,
  emit,
  appendCheckpointIfPending,
}: {
  readonly state: DryWindowState;
  readonly caps: DryVendorCapabilities;
  readonly priceSource: LivePriceSource;
  readonly lastClosedBars?: Map<Asset, ClosedFiveMinuteBar>;
  readonly finalizedResolutions: DryOrderResolution[];
  readonly writer: DryTradingJsonlWriter;
  readonly signal: AbortSignal;
  readonly emit: (event: DryRunEvent) => void;
  readonly appendCheckpointIfPending: boolean;
}): Promise<void> {
  if (state.finalized || state.finalizing || signal.aborted) {
    return;
  }
  state.finalizing = true;
  try {
    await hydrateProxyOutcomes({ state, priceSource, lastClosedBars, signal });
    await hydrateOfficialOutcomes({ state, caps, signal });
    const pending = [...state.perAsset.values()].filter(
      (assetState) =>
        assetState.order !== null && assetState.officialOutcome === null,
    );
    if (appendCheckpointIfPending && !state.checkpointAppended) {
      state.checkpointAppended = true;
      await writer.append({
        type: "window_checkpoint",
        atMs: Date.now(),
        windowStartMs: state.window.windowStartMs,
        windowEndMs: state.window.windowEndMs,
        status:
          pending.length > 0 ? "official-pending" : "official-ready",
        orders: serializeWindowOrders({ state }),
      });
    }
    if (pending.length > 0) {
      scheduleOfficialRetry({
        state,
        caps,
        priceSource,
        finalizedResolutions,
        writer,
        signal,
        emit,
      });
      return;
    }

    const resolutions = orderResolutionsForWindow({ state });
    const windowMetrics = computeDryAggregateMetrics({ resolutions });
    finalizedResolutions.push(...resolutions);
    const sessionMetrics = computeDryAggregateMetrics({
      resolutions: finalizedResolutions,
    });
    state.finalized = true;
    await writer.append({
      type: "window_finalized",
      atMs: Date.now(),
      windowStartMs: state.window.windowStartMs,
      windowEndMs: state.window.windowEndMs,
      orders: serializeWindowOrders({ state }),
      metrics: {
        window: windowMetrics,
        session: sessionMetrics,
      },
    });
    emit({
      kind: "window-finalized",
      atMs: Date.now(),
      windowStartMs: state.window.windowStartMs,
      windowEndMs: state.window.windowEndMs,
      metrics: windowMetrics,
    });
  } finally {
    state.finalizing = false;
  }
}

function scheduleOfficialRetry({
  state,
  caps,
  priceSource,
  finalizedResolutions,
  writer,
  signal,
  emit,
}: {
  readonly state: DryWindowState;
  readonly caps: DryVendorCapabilities;
  readonly priceSource: LivePriceSource;
  readonly finalizedResolutions: DryOrderResolution[];
  readonly writer: DryTradingJsonlWriter;
  readonly signal: AbortSignal;
  readonly emit: (event: DryRunEvent) => void;
}): void {
  if (state.finalizeRetryTimer !== null || state.finalized) {
    return;
  }
  state.finalizeRetryTimer = setTimeout(() => {
    state.finalizeRetryTimer = null;
    void finalizeDryWindow({
      state,
      caps,
      priceSource,
      finalizedResolutions,
      writer,
      signal,
      emit,
      appendCheckpointIfPending: false,
    });
  }, OFFICIAL_RESOLUTION_RETRY_MS);
}

async function hydrateProxyOutcomes({
  state,
  priceSource,
  lastClosedBars,
  signal,
}: {
  readonly state: DryWindowState;
  readonly priceSource: LivePriceSource;
  readonly lastClosedBars?: Map<Asset, ClosedFiveMinuteBar>;
  readonly signal: AbortSignal;
}): Promise<void> {
  await Promise.all(
    [...state.perAsset.entries()].map(async ([asset, assetState]) => {
      if (assetState.order === null || assetState.proxyOutcome !== null) {
        return;
      }
      let bar = lastClosedBars?.get(asset) ?? null;
      if (bar?.openTimeMs !== state.window.windowStartMs) {
        try {
          bar = await priceSource.fetchExactFiveMinuteBar({
            asset,
            openTimeMs: state.window.windowStartMs,
            signal,
          });
        } catch {
          return;
        }
      }
      const line = assetState.record.line ?? bar?.open ?? null;
      if (bar === null || line === null) {
        return;
      }
      assetState.proxyOutcome = {
        winningSide: bar.close >= line ? "up" : "down",
        line,
        close: bar.close,
        closeTimeMs: bar.closeTimeMs,
      };
    }),
  );
}

async function hydrateOfficialOutcomes({
  state,
  caps,
  signal,
}: {
  readonly state: DryWindowState;
  readonly caps: DryVendorCapabilities;
  readonly signal: AbortSignal;
}): Promise<void> {
  await Promise.all(
    [...state.perAsset.values()].map(async (assetState) => {
      if (
        assetState.order === null ||
        assetState.officialOutcome !== null ||
        assetState.record.market === null
      ) {
        return;
      }
      let outcome;
      try {
        outcome = await caps.resolveMarketOutcome({
          market: assetState.record.market,
          signal,
        });
      } catch (error) {
        assetState.officialPendingReason = (error as Error).message;
        return;
      }
      if (outcome.status === "resolved") {
        assetState.officialOutcome = outcome.winningSide;
        assetState.officialResolvedAtMs = outcome.resolvedAtMs;
        assetState.officialPendingReason = null;
      } else {
        assetState.officialPendingReason = outcome.reason;
      }
    }),
  );
}

function orderResolutionsForWindow({
  state,
}: {
  readonly state: DryWindowState;
}): DryOrderResolution[] {
  const out: DryOrderResolution[] = [];
  for (const assetState of state.perAsset.values()) {
    if (assetState.order === null || assetState.officialOutcome === null) {
      continue;
    }
    out.push({
      order: assetState.order.order,
      officialWinningSide: assetState.officialOutcome,
      proxyWinningSide: assetState.proxyOutcome?.winningSide ?? null,
    });
  }
  return out;
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
  readonly emit: (event: DryRunEvent) => void;
}): Promise<void> {
  try {
    const book = await vendor.fetchBook({ market, signal });
    books.set(book.market.vendorRef, book);
  } catch (error) {
    emit({
      kind: "warn",
      atMs: Date.now(),
      message: `${labelAsset(market.asset)} book refresh failed: ${(error as Error).message}`,
    });
  }
}

function activeDryMarkets({
  windows,
}: {
  readonly windows: ReadonlyMap<number, DryWindowState>;
}): TradableMarket[] {
  const markets: TradableMarket[] = [];
  for (const state of windows.values()) {
    if (state.finalized) {
      continue;
    }
    for (const assetState of state.perAsset.values()) {
      const market = assetState.record.market;
      if (market !== null) {
        markets.push(market);
      }
    }
  }
  return markets;
}

function queueAheadAtLimit({
  book,
  side,
  limitPrice,
}: {
  readonly book: UpDownBook;
  readonly side: "up" | "down";
  readonly limitPrice: number;
}): number | null {
  const levels = side === "up" ? book.up.bidLevels : book.down.bidLevels;
  if (levels === undefined) {
    return null;
  }
  const level = levels.find((entry) => Math.abs(entry.price - limitPrice) < 1e-9);
  return level?.size ?? 0;
}

function topForSide({
  book,
  side,
}: {
  readonly book: UpDownBook;
  readonly side: "up" | "down";
}): { readonly bestBid: number | null; readonly bestAsk: number | null } {
  return side === "up" ? book.up : book.down;
}

function bestFromLevels({
  levels,
  side,
}: {
  readonly levels: readonly PriceLevel[];
  readonly side: "bid" | "ask";
}): number | null {
  let best: number | null = null;
  for (const level of levels) {
    if (best === null) {
      best = level.price;
      continue;
    }
    if (side === "bid" ? level.price > best : level.price < best) {
      best = level.price;
    }
  }
  return best;
}

function serializeWindowOrders({
  state,
}: {
  readonly state: DryWindowState;
}): unknown[] {
  return [...state.perAsset.values()].flatMap((assetState) =>
    assetState.order === null
      ? []
      : [
          {
            ...serializeDryOrder({ envelope: assetState.order }),
            proxyOutcome: assetState.proxyOutcome,
            officialOutcome: assetState.officialOutcome,
            officialResolvedAtMs: assetState.officialResolvedAtMs,
            officialPendingReason: assetState.officialPendingReason,
          },
        ],
  );
}

function serializeDryOrder({
  envelope,
}: {
  readonly envelope: DryOrderEnvelope;
}): Record<string, unknown> {
  const { order, decision } = envelope;
  return {
    id: order.id,
    asset: order.asset,
    windowStartMs: order.windowStartMs,
    windowEndMs: order.windowEndMs,
    vendorRef: order.vendorRef,
    outcomeRef: order.outcomeRef,
    side: order.side,
    limitPrice: order.limitPrice,
    sharesIfFilled: order.sharesIfFilled,
    placedAtMs: order.placedAtMs,
    expiresAtMs: order.expiresAtMs,
    queueAheadShares: order.queueAheadShares,
    observedAtLimitShares: order.observedAtLimitShares,
    canonicalFilledShares: order.canonicalFilledShares,
    canonicalCostUsd: order.canonicalCostUsd,
    canonicalFirstFillAtMs: order.canonicalFirstFillAtMs,
    canonicalFullFillAtMs: order.canonicalFullFillAtMs,
    touchFilledAtMs: order.touchFilledAtMs,
    entryPrice: envelope.entryPrice,
    line: envelope.line,
    polymarketReferencePrice: null,
    upBestBid: envelope.upBestBid,
    upBestAsk: envelope.upBestAsk,
    downBestBid: envelope.downBestBid,
    downBestAsk: envelope.downBestAsk,
    spread: envelope.spread,
    remaining: decision.snapshot.remaining,
    distanceBp: decision.snapshot.distanceBp,
    samples: decision.samples,
    modelProbability: decision.chosen.ourProbability,
    edge: decision.chosen.edge,
  };
}

function formatTableRange({
  table,
}: {
  readonly table: ProbabilityTable;
}): string {
  const first = new Date(table.trainingRangeMs.firstWindowMs)
    .toISOString()
    .slice(0, 10);
  const last = new Date(table.trainingRangeMs.lastWindowMs)
    .toISOString()
    .slice(0, 10);
  return `${first}..${last}`;
}
