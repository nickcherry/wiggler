import { EMA50_BOOTSTRAP_BARS } from "@alea/constants/trading";
import { fetchRecentFiveMinuteBars } from "@alea/lib/livePrices/binancePerp/fetchRecentFiveMinuteBars";
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
import type {
  DecisionSkipReason,
  TradeDecision,
} from "@alea/lib/trading/decision/types";
import type { DryRunEvent } from "@alea/lib/trading/dryRun/types";
import type {
  ProbabilityTable,
  RemainingMinutes,
} from "@alea/lib/trading/types";
import type {
  TradableMarket,
  UpDownBook,
  Vendor,
} from "@alea/lib/trading/vendor/types";
import type { Asset } from "@alea/types/assets";

const BOOK_POLL_INTERVAL_MS = 2_000;
const TICK_INTERVAL_MS = 250;

export type DryRunParams = {
  /**
   * Vendor used only for read-only operations (`discoverMarket`,
   * `fetchBook`). The dry-run never places orders, never opens the
   * user fill stream, and never touches lifetime PnL — anything that
   * would touch the wallet.
   */
  readonly vendor: Vendor;
  readonly assets: readonly Asset[];
  readonly table: ProbabilityTable;
  readonly minEdge: number;
  readonly emit: (event: DryRunEvent) => void;
  readonly signal: AbortSignal;
};

/**
 * Long-running dry-run trader. Same decision pipeline as the live
 * runner but exercises only the read-side of the `Vendor` interface
 * (`discoverMarket` + `fetchBook`); no auth use, no order placement,
 * no fills, no Telegram. This is the right command to inspect signals
 * for hours without risking a single dollar.
 *
 * Wiring:
 *   - Binance perp live feed (BBO + 5m kline closes, auto-reconnect)
 *     for current price and EMA-50 maintenance.
 *   - REST hydration of recent closed 5m bars per asset for the EMA
 *     seed.
 *   - Per-asset window state: line, discovered market, polled book.
 *   - Decision evaluator firing once per minute-boundary crossing.
 *
 * Returns when `signal` aborts; cleanup is best-effort but always runs.
 */
export async function runDryRun({
  vendor,
  assets,
  table,
  minEdge,
  emit,
  signal,
}: DryRunParams): Promise<void> {
  const emas = new Map<Asset, FiveMinuteEmaTracker>();
  const atrs = new Map<Asset, FiveMinuteAtrTracker>();
  const lastTick = new Map<Asset, LivePriceTick>();
  const windows = new Map<Asset, AssetWindowState>();
  const books = new Map<Asset, UpDownBook>();

  for (const asset of assets) {
    emas.set(asset, createFiveMinuteEmaTracker());
    atrs.set(asset, createFiveMinuteAtrTracker());
  }

  emit({
    kind: "info",
    atMs: Date.now(),
    message: `dry-run starting: vendor=${vendor.id} assets=${assets.join(",")} minEdge=${minEdge.toFixed(3)} table.range=${formatTableRange({ table })}`,
  });

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
      const atrTracker = atrs.get(asset);
      for (const bar of bars) {
        tracker?.append(bar);
        atrTracker?.append(bar);
      }
      const ema = tracker?.currentValue();
      const atr = atrTracker?.currentValue();
      emit({
        kind: "info",
        atMs: Date.now(),
        message: `${labelAsset(asset)} hydrated ${bars.length} closed 5m bars, ema50=${ema === null || ema === undefined ? "warming" : ema.toFixed(2)}, atr14=${atr === null || atr === undefined ? "warming" : atr.toFixed(2)}`,
      });
    } catch (error) {
      emit({
        kind: "warn",
        atMs: Date.now(),
        message: `${labelAsset(asset)} bootstrap failed: ${(error as Error).message}`,
      });
    }
  }

  if (signal.aborted) {
    return;
  }

  const feedHandle = streamBinancePerpLive({
    assets,
    onTick: (tick) => {
      lastTick.set(tick.asset, tick);
    },
    onBarClose: (bar: ClosedFiveMinuteBar) => {
      const tracker = emas.get(bar.asset);
      const atrTracker = atrs.get(bar.asset);
      const emaIncorporated = tracker !== undefined && tracker.append(bar);
      const atrIncorporated = atrTracker !== undefined && atrTracker.append(bar);
      if (emaIncorporated || atrIncorporated) {
        emit({
          kind: "info",
          atMs: Date.now(),
          message: `${labelAsset(bar.asset)} 5m bar closed @ ${new Date(bar.openTimeMs).toISOString().slice(11, 16)} UTC, close=${bar.close}, ema50=${tracker?.currentValue()?.toFixed(2) ?? "warming"}, atr14=${atrTracker?.currentValue()?.toFixed(2) ?? "warming"}`,
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

  const bookPollTimer = setInterval(() => {
    if (signal.aborted) {
      return;
    }
    for (const asset of assets) {
      const ws = windows.get(asset);
      if (ws === undefined || ws.market === null) {
        continue;
      }
      void refreshBook({
        vendor,
        asset,
        market: ws.market,
        books,
        signal,
        emit,
      });
    }
  }, BOOK_POLL_INTERVAL_MS);

  const tickTimer = setInterval(() => {
    if (signal.aborted) {
      return;
    }
    const nowMs = Date.now();
    const windowStartMs = currentWindowStartMs({ nowMs });

    for (const asset of assets) {
      let ws = windows.get(asset);
      if (ws === undefined || ws.windowStartMs !== windowStartMs) {
        if (ws !== undefined) {
          emit({
            kind: "info",
            atMs: nowMs,
            message: formatWindowSummary({ asset, windowState: ws }),
          });
        }
        const newState: AssetWindowState = {
          asset,
          windowStartMs,
          windowEndMs: windowStartMs + FIVE_MINUTES_MS,
          line: lastTick.get(asset)?.mid ?? null,
          lineCapturedAtMs: lastTick.has(asset) ? nowMs : null,
          market: null,
          marketStatus: "pending",
          lastDecisionRemaining: null,
          decisionsByRemaining: new Map(),
        };
        windows.set(asset, newState);
        ws = newState;
        void hydrateMarket({
          asset,
          vendor,
          windowState: ws,
          signal,
          emit,
        });
      }

      if (ws.line === null) {
        const tick = lastTick.get(asset);
        if (tick !== undefined) {
          ws.line = tick.mid;
          ws.lineCapturedAtMs = tick.receivedAtMs;
          emit({
            kind: "info",
            atMs: nowMs,
            message: `${labelAsset(asset)} line captured: ${tick.mid.toFixed(toFixedFor({ asset }))} @ ${new Date(tick.receivedAtMs).toISOString().slice(11, 19)}`,
          });
        }
      }

      const remaining = flooredRemainingMinutes({
        windowStartMs: ws.windowStartMs,
        nowMs,
      });
      if (remaining === null || remaining === ws.lastDecisionRemaining) {
        continue;
      }
      const tick = lastTick.get(asset);
      const tracker = emas.get(asset);
      const atrTracker = atrs.get(asset);
      const market = ws.market;
      const book = books.get(asset);
      if (
        tick === undefined ||
        tracker === undefined ||
        atrTracker === undefined ||
        market === null ||
        ws.line === null
      ) {
        continue;
      }

      const decision = evaluateDecision({
        asset,
        windowStartMs: ws.windowStartMs,
        nowMs,
        line: ws.line,
        currentPrice: tick.mid,
        ema50: tracker.currentValue(),
        atr14: atrTracker.currentValue(),
        upBestBid: book?.up.bestBid ?? null,
        downBestBid: book?.down.bestBid ?? null,
        upTokenId: market.upRef,
        downTokenId: market.downRef,
        table,
        minEdge,
      });

      ws.lastDecisionRemaining = remaining;
      ws.decisionsByRemaining.set(remaining, decision);
      emit({ kind: "decision", atMs: nowMs, decision });
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
  await feedHandle.stop();
  emit({
    kind: "info",
    atMs: Date.now(),
    message: "dry-run stopped",
  });
}

type AssetWindowState = {
  readonly asset: Asset;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  line: number | null;
  lineCapturedAtMs: number | null;
  market: TradableMarket | null;
  marketStatus: "pending" | "ready" | "missing" | "error";
  lastDecisionRemaining: RemainingMinutes | null;
  readonly decisionsByRemaining: Map<RemainingMinutes, TradeDecision>;
};

async function hydrateMarket({
  asset,
  vendor,
  windowState,
  signal,
  emit,
}: {
  readonly asset: Asset;
  readonly vendor: Vendor;
  readonly windowState: AssetWindowState;
  readonly signal: AbortSignal;
  readonly emit: (event: DryRunEvent) => void;
}): Promise<void> {
  const windowStartUnixSeconds = Math.floor(windowState.windowStartMs / 1000);
  try {
    const market = await vendor.discoverMarket({
      asset,
      windowStartUnixSeconds,
      signal,
    });
    if (market === null) {
      windowState.marketStatus = "missing";
      emit({
        kind: "warn",
        atMs: Date.now(),
        message: `${labelAsset(asset)} no ${vendor.id} market for window ${new Date(windowState.windowStartMs).toISOString().slice(11, 16)}`,
      });
      return;
    }
    windowState.market = market;
    windowState.marketStatus = "ready";
    emit({
      kind: "info",
      atMs: Date.now(),
      message: `${labelAsset(asset)} discovered ${market.displayLabel ?? market.vendorRef}, accepting=${market.acceptingOrders}`,
    });
  } catch (error) {
    windowState.marketStatus = "error";
    emit({
      kind: "error",
      atMs: Date.now(),
      message: `${labelAsset(asset)} market discovery failed: ${(error as Error).message}`,
    });
  }
}

async function refreshBook({
  vendor,
  asset,
  market,
  books,
  signal,
  emit,
}: {
  readonly vendor: Vendor;
  readonly asset: Asset;
  readonly market: TradableMarket;
  readonly books: Map<Asset, UpDownBook>;
  readonly signal: AbortSignal;
  readonly emit: (event: DryRunEvent) => void;
}): Promise<void> {
  try {
    const book = await vendor.fetchBook({ market, signal });
    books.set(asset, book);
  } catch (error) {
    emit({
      kind: "warn",
      atMs: Date.now(),
      message: `${labelAsset(asset)} book refresh failed: ${(error as Error).message}`,
    });
  }
}

function formatWindowSummary({
  asset,
  windowState,
}: {
  readonly asset: Asset;
  readonly windowState: AssetWindowState;
}): string {
  const windowEndIso = new Date(windowState.windowEndMs)
    .toISOString()
    .slice(11, 16);
  const decisions = [...windowState.decisionsByRemaining.entries()].sort(
    ([a], [b]) => b - a,
  );
  if (decisions.length === 0) {
    return `${labelAsset(asset)} window ${windowEndIso} closed: no decisions emitted (market=${windowState.marketStatus}, line=${windowState.line === null ? "n/a" : windowState.line.toFixed(toFixedFor({ asset }))})`;
  }
  const trades: [
    RemainingMinutes,
    Extract<TradeDecision, { kind: "trade" }>,
  ][] = [];
  const skips: [RemainingMinutes, Extract<TradeDecision, { kind: "skip" }>][] =
    [];
  for (const [rem, d] of decisions) {
    if (d.kind === "trade") {
      trades.push([rem, d]);
    } else {
      skips.push([rem, d]);
    }
  }
  const skipBreakdown = countSkipReasons({ skips });
  if (trades.length === 0) {
    return `${labelAsset(asset)} window ${windowEndIso} closed: 0 trades / ${skips.length} skips (${skipBreakdown})`;
  }
  const tradeSummary = trades
    .map(
      ([rem, d]) =>
        `+${5 - rem}m=${d.chosen.side.toUpperCase()}@${d.chosen.bid?.toFixed(2) ?? "?"}/edge=${formatSignedNumber({ value: d.chosen.edge ?? 0, places: 3 })}`,
    )
    .join(" ");
  return `${labelAsset(asset)} window ${windowEndIso} closed: ${trades.length} trades [${tradeSummary}] / ${skips.length} skips (${skipBreakdown})`;
}

function countSkipReasons({
  skips,
}: {
  readonly skips: readonly [
    RemainingMinutes,
    Extract<TradeDecision, { kind: "skip" }>,
  ][];
}): string {
  const counts = new Map<DecisionSkipReason, number>();
  for (const [, decision] of skips) {
    counts.set(decision.reason, (counts.get(decision.reason) ?? 0) + 1);
  }
  if (counts.size === 0) {
    return "—";
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${reason}=${n}`)
    .join(",");
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

function labelAsset(asset: Asset): string {
  return asset.toUpperCase().padEnd(5);
}

function toFixedFor({ asset }: { readonly asset: Asset }): number {
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

function formatSignedNumber({
  value,
  places,
}: {
  readonly value: number;
  readonly places: number;
}): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(places)}`;
}
