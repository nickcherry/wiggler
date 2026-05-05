import { resolve as resolvePath } from "node:path";

import type { DatabaseClient } from "@alea/lib/db/types";
import type { StreamHandle } from "@alea/lib/exchangePrices/types";
import {
  currentWindowStartMs,
  FIVE_MINUTES_MS,
} from "@alea/lib/livePrices/fiveMinuteWindow";
import { captureBinancePerp } from "@alea/lib/marketCapture/captureBinancePerp";
import {
  captureCoinbasePerp,
  captureCoinbaseSpot,
} from "@alea/lib/marketCapture/captureCoinbase";
import { capturePolymarket } from "@alea/lib/marketCapture/capturePolymarket";
import { capturePolymarketChainlink } from "@alea/lib/marketCapture/capturePolymarketChainlink";
import { createCaptureSink } from "@alea/lib/marketCapture/captureSink";
import { ingestSessionJsonl } from "@alea/lib/marketCapture/ingestSessionJsonl";
import {
  createCaptureJsonlWriter,
} from "@alea/lib/marketCapture/jsonlWriter";
import { scanPendingSessions } from "@alea/lib/marketCapture/scanPendingSessions";
import { sessionForWindow } from "@alea/lib/marketCapture/session";
import { discoverPolymarketMarket } from "@alea/lib/trading/vendor/polymarket/discoverMarket";
import type {
  MarketDataStreamHandle,
  TradableMarket,
} from "@alea/lib/trading/vendor/types";
import type { Asset } from "@alea/types/assets";

/**
 * Lookahead for Polymarket discovery: how far before window start we
 * pre-discover the next set of markets. The gamma-api lookup takes
 * ~200ms per call (×5 assets); doing it 30s ahead gives plenty of
 * margin so the WS subscription is ready when the window opens.
 */
const DISCOVERY_LEAD_MS = 30_000;

/**
 * Margin after window-end before we consider a window "definitely
 * past" for stream subscription purposes. The market-data stream
 * still emits resolution events for a closed window for several
 * seconds; we want those captured under the window they belong to,
 * not skipped because we already moved on.
 */
const WINDOW_TAIL_MS = 15_000;

/**
 * Cadence at which the capture loop checks for window rollovers and
 * subscription refreshes. Faster than the 250ms used by the trading
 * runner — we don't need the precision and the loop body is light.
 */
const TICK_INTERVAL_MS = 1_000;

export type CaptureLogEvent = {
  readonly kind: "info" | "warn" | "error";
  readonly atMs: number;
  readonly message: string;
};

export type RunCaptureParams = {
  readonly db: DatabaseClient;
  readonly assets: readonly Asset[];
  readonly dir: string;
  readonly signal: AbortSignal;
  readonly log: (event: CaptureLogEvent) => void;
  /**
   * If false, JSONL files are written but never loaded into Postgres
   * (the operator is expected to run `data:ingest-pending` later).
   * Default: true. Useful for the first calibration run where we
   * want to measure event rate before committing to DB.
   */
  readonly ingest?: boolean;
};

/**
 * Long-running market-data capture loop.
 *
 * State machine:
 *   1. Boot: scan `dir` for orphaned `.jsonl` files from prior runs
 *      and ingest them (if any). Open a fresh JSONL writer for the
 *      current window.
 *   2. Spin up Binance perp WS — long-lived, doesn't change with
 *      windows.
 *   3. Spin up the Polymarket WS for the current window (and the
 *      next window when we're within `DISCOVERY_LEAD_MS` of its
 *      start). Re-create on each window boundary so the new
 *      window's condition ids are subscribed in time.
 *   4. Tick every `TICK_INTERVAL_MS`: rotate the JSONL if the
 *      writer's view of the wall clock has crossed a boundary, and
 *      check whether we need to discover the next window's markets.
 *   5. On signal abort: stop both subscriptions, close the writer,
 *      drain any in-flight ingestions, return.
 *
 * The runner does NOT crash on errors — every reasonably-recoverable
 * failure is logged and continues. Only an unrecoverable abort
 * (signal abort, or fatal error in the subscriber wiring itself)
 * causes return.
 */
export async function runCapture({
  db,
  assets,
  dir,
  signal,
  log,
  ingest = true,
}: RunCaptureParams): Promise<void> {
  const writer = await createCaptureJsonlWriter({
    dir,
    onRollover: async ({ closedSession, closedPath }) => {
      log({
        kind: "info",
        atMs: Date.now(),
        message: `rotated session ${closedSession.windowKey} → ${closedPath}`,
      });
      if (ingest) {
        await ingestPath({ db, path: closedPath, log });
      }
    },
    onError: (error) => {
      log({
        kind: "error",
        atMs: Date.now(),
        message: `writer error: ${error.message}`,
      });
    },
  });

  const sink = createCaptureSink({
    writer,
    onError: (error) => {
      log({
        kind: "error",
        atMs: Date.now(),
        message: `sink error: ${error.message}`,
      });
    },
  });

  // Recover any orphaned sessions before we start writing new
  // events. We exclude the active filename so the new writer's
  // file is never racing the recovery ingester.
  const activeSession = writer.currentSession();
  if (activeSession !== null && ingest) {
    const pending = await scanPendingSessions({
      dir,
      activeFileName: activeSession.fileName,
    });
    for (const entry of pending) {
      log({
        kind: "info",
        atMs: Date.now(),
        message: `recovering pending session ${entry.fileName} (complete=${entry.hasCompleteMarker})`,
      });
      await ingestPath({ db, path: entry.path, log });
    }
  }

  // Long-running price-feed subscriptions. None of these are window-
  // scoped — they get one socket per process for the lifetime of the
  // run and reconnect themselves on drops. The Polymarket *market-
  // data* WS is window-scoped (it subscribes to the active up/down
  // markets) and is handled separately in `polyState` below.
  const priceHandles: StreamHandle[] = [
    captureBinancePerp({ assets, sink }),
    captureCoinbasePerp({ assets, sink }),
    captureCoinbaseSpot({ assets, sink }),
    capturePolymarketChainlink({ assets, sink }),
  ];

  // Tracks active Polymarket subscriptions so we can swap them at
  // window boundaries without dropping in-flight events.
  const polyState: PolyState = {
    handle: null,
    activeMarkets: new Map(),
    inflightDiscovery: new Set(),
  };

  await refreshPolymarketSubscription({ assets, polyState, sink, log, signal });

  const tickHandle = setInterval(() => {
    if (signal.aborted) {
      return;
    }
    void refreshPolymarketSubscription({
      assets,
      polyState,
      sink,
      log,
      signal,
    });
  }, TICK_INTERVAL_MS);

  await waitForSignal(signal);

  clearInterval(tickHandle);
  log({
    kind: "info",
    atMs: Date.now(),
    message: "shutdown signal received; closing subscriptions",
  });

  await polyState.handle?.stop();
  polyState.handle = null;
  await Promise.allSettled(priceHandles.map((handle) => handle.stop()));
  await writer.close();

  log({
    kind: "info",
    atMs: Date.now(),
    message: "capture stopped cleanly",
  });
}

type PolyState = {
  handle: MarketDataStreamHandle | null;
  // Markets currently subscribed, keyed by windowStartMs.
  activeMarkets: Map<number, readonly TradableMarket[]>;
  // Window-start-ms values currently being discovered (in-flight
  // gamma-api calls). Prevents a slow lookup from being kicked off
  // twice while still in flight.
  inflightDiscovery: Set<number>;
};

async function refreshPolymarketSubscription({
  assets,
  polyState,
  sink,
  log,
  signal,
}: {
  readonly assets: readonly Asset[];
  readonly polyState: PolyState;
  readonly sink: ReturnType<typeof createCaptureSink>;
  readonly log: (event: CaptureLogEvent) => void;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (signal.aborted) {
    return;
  }
  const nowMs = Date.now();
  const currentStart = currentWindowStartMs({ nowMs });
  const nextStart = currentStart + FIVE_MINUTES_MS;

  // Drop windows whose tail has fully passed.
  for (const windowStart of [...polyState.activeMarkets.keys()]) {
    if (windowStart + FIVE_MINUTES_MS + WINDOW_TAIL_MS < nowMs) {
      polyState.activeMarkets.delete(windowStart);
    }
  }

  // Discover current window if missing.
  if (
    !polyState.activeMarkets.has(currentStart) &&
    !polyState.inflightDiscovery.has(currentStart)
  ) {
    polyState.inflightDiscovery.add(currentStart);
    void discoverWindow({ assets, windowStartMs: currentStart, signal })
      .then((markets) => {
        polyState.inflightDiscovery.delete(currentStart);
        if (markets.length > 0) {
          polyState.activeMarkets.set(currentStart, markets);
          rebuildPolymarketSubscription({ polyState, sink, log });
        }
      })
      .catch((error) => {
        polyState.inflightDiscovery.delete(currentStart);
        log({
          kind: "warn",
          atMs: Date.now(),
          message: `polymarket discover (current ${new Date(currentStart).toISOString()}) failed: ${(error as Error).message}`,
        });
      });
  }

  // Discover next window if we're inside the lookahead.
  if (
    nowMs + DISCOVERY_LEAD_MS >= nextStart &&
    !polyState.activeMarkets.has(nextStart) &&
    !polyState.inflightDiscovery.has(nextStart)
  ) {
    polyState.inflightDiscovery.add(nextStart);
    void discoverWindow({ assets, windowStartMs: nextStart, signal })
      .then((markets) => {
        polyState.inflightDiscovery.delete(nextStart);
        if (markets.length > 0) {
          polyState.activeMarkets.set(nextStart, markets);
          rebuildPolymarketSubscription({ polyState, sink, log });
        }
      })
      .catch((error) => {
        polyState.inflightDiscovery.delete(nextStart);
        log({
          kind: "warn",
          atMs: Date.now(),
          message: `polymarket discover (next ${new Date(nextStart).toISOString()}) failed: ${(error as Error).message}`,
        });
      });
  }
}

function rebuildPolymarketSubscription({
  polyState,
  sink,
  log,
}: {
  readonly polyState: PolyState;
  readonly sink: ReturnType<typeof createCaptureSink>;
  readonly log: (event: CaptureLogEvent) => void;
}): void {
  const markets: TradableMarket[] = [];
  for (const set of polyState.activeMarkets.values()) {
    for (const market of set) {
      markets.push(market);
    }
  }
  if (markets.length === 0) {
    return;
  }
  if (polyState.handle !== null) {
    void polyState.handle.stop();
    polyState.handle = null;
  }
  log({
    kind: "info",
    atMs: Date.now(),
    message: `subscribing polymarket WS to ${markets.length} markets across ${polyState.activeMarkets.size} windows`,
  });
  polyState.handle = capturePolymarket({ markets, sink });
}

async function discoverWindow({
  assets,
  windowStartMs,
  signal,
}: {
  readonly assets: readonly Asset[];
  readonly windowStartMs: number;
  readonly signal: AbortSignal;
}): Promise<readonly TradableMarket[]> {
  const windowStartUnixSeconds = Math.floor(windowStartMs / 1000);
  const out: TradableMarket[] = [];
  for (const asset of assets) {
    if (signal.aborted) {
      return out;
    }
    const discovered = await discoverPolymarketMarket({
      asset,
      windowStartUnixSeconds,
      signal,
    });
    if (discovered !== null) {
      out.push(discovered.market);
    }
  }
  return out;
}

async function ingestPath({
  db,
  path,
  log,
}: {
  readonly db: DatabaseClient;
  readonly path: string;
  readonly log: (event: CaptureLogEvent) => void;
}): Promise<void> {
  try {
    const result = await ingestSessionJsonl({ db, path });
    log({
      kind: "info",
      atMs: Date.now(),
      message: `ingested ${result.path} rows=${result.rowsInserted} parseErrors=${result.parseErrors}`,
    });
  } catch (error) {
    log({
      kind: "error",
      atMs: Date.now(),
      message: `ingest of ${path} failed: ${(error as Error).message}`,
    });
  }
}

function waitForSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Default location for capture JSONLs — siblings of the dry-trading
 * logs under `tmp/` so all bot-derived data lives in one place.
 */
export function defaultCaptureDir({
  repoRoot,
}: {
  readonly repoRoot: string;
}): string {
  return resolvePath(repoRoot, "tmp/market-capture");
}

/**
 * Re-exported so the recovery CLI command (`data:ingest-pending`) can
 * call it without importing the runner.
 */
export { sessionForWindow };
