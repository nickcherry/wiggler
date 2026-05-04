import {
  currentWindowStartMs,
  FIVE_MINUTES_MS,
  nextWindowStartMs,
} from "@alea/lib/livePrices/fiveMinuteWindow";
import { emptyReliabilitySummary } from "@alea/lib/reliability/computeReliabilitySummary";
import { startReliabilityFeeds } from "@alea/lib/reliability/feeds/startReliabilityFeeds";
import { finalizeReliabilityWindow } from "@alea/lib/reliability/finalizeReliabilityWindow";
import {
  baselineReliabilitySource,
  RELIABILITY_SCHEMA_VERSION,
  type ReliabilityAssetWindow,
  type ReliabilityCaptureEvent,
  type ReliabilityCapturePayload,
  type ReliabilityPriceTick,
  type ReliabilitySource,
  type ReliabilitySourceCell,
  type ReliabilitySourceHealth,
  reliabilitySourceValues,
} from "@alea/lib/reliability/types";
import { discoverPolymarketMarket } from "@alea/lib/trading/vendor/polymarket/discoverMarket";
import type { Asset } from "@alea/types/assets";

const WINDOW_PREOPEN_MS = 500;
const MAX_RETAINED_ERRORS = 500;

export async function runReliabilityCapture({
  assets,
  durationMs,
  graceMs,
  nearZeroThresholdBp,
  resumeFrom,
  persist,
  emit,
  signal,
}: {
  readonly assets: readonly Asset[];
  readonly durationMs: number | null;
  readonly graceMs: number;
  readonly nearZeroThresholdBp: number;
  readonly resumeFrom?: ReliabilityCapturePayload;
  readonly persist: (capture: ReliabilityCapturePayload) => Promise<void>;
  readonly emit: (event: ReliabilityCaptureEvent) => void;
  readonly signal: AbortSignal;
}): Promise<ReliabilityCapturePayload> {
  const startedAtMs = Date.now();
  const runStartWindowMs = nextWindowStartMs({ nowMs: startedAtMs });
  const captureEndMs =
    durationMs === null ? null : runStartWindowMs + durationMs;
  const lastWindowStartMs =
    captureEndMs === null
      ? null
      : currentWindowStartMs({
          nowMs: Math.max(runStartWindowMs, captureEndMs - 1),
        });
  const stopAfterMs =
    lastWindowStartMs === null
      ? null
      : lastWindowStartMs + FIVE_MINUTES_MS + graceMs + 250;
  const sourceHealth = createSourceHealth();
  const healthBySource = new Map(
    sourceHealth.map((health) => [health.source, health] as const),
  );
  const latestTicks = new Map<string, ReliabilityPriceTick>();
  const capture: ReliabilityCapturePayload = {
    schemaVersion: RELIABILITY_SCHEMA_VERSION,
    startedAtMs: resumeFrom?.startedAtMs ?? startedAtMs,
    updatedAtMs: startedAtMs,
    requestedDurationMs: durationMs ?? 0,
    captureStartWindowMs: resumeFrom?.captureStartWindowMs ?? runStartWindowMs,
    captureEndMs,
    graceMs,
    nearZeroThresholdBp,
    assets: [...assets],
    sources: [...reliabilitySourceValues],
    baselineSource: baselineReliabilitySource,
    activeWindows: [],
    completedWindows:
      resumeFrom === undefined
        ? []
        : dedupeCompletedWindows({ windows: resumeFrom.completedWindows }),
    sourceHealth,
    errors: resumeFrom?.errors.slice(-MAX_RETAINED_ERRORS) ?? [],
    summary: emptyReliabilitySummary({ nearZeroThresholdBp }),
  };

  let persistQueue = Promise.resolve();
  const schedulePersist = (): void => {
    persistQueue = persistQueue
      .catch(() => undefined)
      .then(() => persist(capture))
      .catch((error) => {
        addError({
          capture,
          source: null,
          message: `persist failed: ${(error as Error).message}`,
        });
      });
  };

  schedulePersist();
  emit({
    kind: "info",
    atMs: Date.now(),
    message: `waiting for full window ${formatTime({ ms: runStartWindowMs })} UTC`,
  });

  const feedHandle = startReliabilityFeeds({
    assets,
    onTick: (tick) => {
      const health = healthBySource.get(tick.source);
      if (health !== undefined) {
        health.ticks += 1;
        health.lastTickAtMs = tick.receivedAtMs;
      }
      latestTicks.set(
        tickKey({ source: tick.source, asset: tick.asset }),
        tick,
      );
      captureTick({ capture, tick, graceMs });
    },
    onOpen: (source) => {
      const health = healthBySource.get(source);
      if (health !== undefined) {
        health.connected = true;
        health.connectCount += 1;
      }
      emit({ kind: "source-open", atMs: Date.now(), source });
      schedulePersist();
    },
    onClose: (source, reason) => {
      const health = healthBySource.get(source);
      if (health !== undefined) {
        health.connected = false;
        health.disconnectCount += 1;
      }
      emit({ kind: "source-close", atMs: Date.now(), source, reason });
      schedulePersist();
    },
    onError: (source, error) => {
      const health = healthBySource.get(source);
      if (health !== undefined) {
        health.errorCount += 1;
        health.lastError = error.message;
      }
      addError({ capture, source, message: error.message });
      emit({
        kind: "error",
        atMs: Date.now(),
        message: `${source}: ${error.message}`,
      });
      schedulePersist();
    },
  });

  let nextToOpenMs = runStartWindowMs;
  const timer = setInterval(() => {
    const nowMs = Date.now();
    while (
      (lastWindowStartMs === null || nextToOpenMs <= lastWindowStartMs) &&
      nowMs >= nextToOpenMs - WINDOW_PREOPEN_MS
    ) {
      openWindow({
        capture,
        assets,
        windowStartMs: nextToOpenMs,
        latestTicks,
        graceMs,
        signal,
        emit,
        schedulePersist,
      });
      nextToOpenMs += FIVE_MINUTES_MS;
    }

    const finalized = finalizeDueWindows({
      capture,
      nowMs,
      graceMs,
    });
    for (const group of groupFinalizedByWindow({ windows: finalized })) {
      emit({
        kind: "window-finalized",
        atMs: nowMs,
        windowStartMs: group.windowStartMs,
        windows: group.windows,
      });
      schedulePersist();
    }
  }, 250);

  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const abort = (): void => resolve();
    signal.addEventListener("abort", abort, { once: true });
    const doneTimer =
      stopAfterMs === null
        ? null
        : setTimeout(resolve, Math.max(0, stopAfterMs - Date.now()));
    signal.addEventListener(
      "abort",
      () => {
        if (doneTimer !== null) {
          clearTimeout(doneTimer);
        }
      },
      { once: true },
    );
  });

  clearInterval(timer);
  await feedHandle.stop();
  for (const health of sourceHealth) {
    health.connected = false;
  }
  schedulePersist();
  await persistQueue;
  emit({
    kind: "info",
    atMs: Date.now(),
    message: "reliability capture stopped",
  });
  return capture;
}

function openWindow({
  capture,
  assets,
  windowStartMs,
  latestTicks,
  graceMs,
  signal,
  emit,
  schedulePersist,
}: {
  readonly capture: ReliabilityCapturePayload;
  readonly assets: readonly Asset[];
  readonly windowStartMs: number;
  readonly latestTicks: ReadonlyMap<string, ReliabilityPriceTick>;
  readonly graceMs: number;
  readonly signal: AbortSignal;
  readonly emit: (event: ReliabilityCaptureEvent) => void;
  readonly schedulePersist: () => void;
}): void {
  const windowEndMs = windowStartMs + FIVE_MINUTES_MS;
  for (const asset of assets) {
    const window = createAssetWindow({ asset, windowStartMs, windowEndMs });
    capture.activeWindows.push(window);
    seedStartFromLatestTick({ window, latestTicks, graceMs });
    setTimeout(
      () => {
        if (signal.aborted) {
          return;
        }
        void discoverMarketForWindow({
          capture,
          window,
          signal,
          schedulePersist,
        });
      },
      Math.max(0, windowStartMs - Date.now()),
    );
  }
  emit({
    kind: "window-opened",
    atMs: Date.now(),
    windowStartMs,
    assetCount: assets.length,
  });
  schedulePersist();
}

function createAssetWindow({
  asset,
  windowStartMs,
  windowEndMs,
}: {
  readonly asset: Asset;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
}): ReliabilityAssetWindow {
  const windowStartUnixSeconds = Math.floor(windowStartMs / 1000);
  return {
    asset,
    status: "active",
    windowStartMs,
    windowEndMs,
    marketSlug: `${asset}-updown-5m-${windowStartUnixSeconds}`,
    conditionId: null,
    marketStatus: "pending",
    marketError: null,
    finalizedAtMs: null,
    sources: createSourceCells(),
  };
}

function createSourceCells(): Record<ReliabilitySource, ReliabilitySourceCell> {
  return {
    "polymarket-chainlink": createCell({ source: "polymarket-chainlink" }),
    "coinbase-spot": createCell({ source: "coinbase-spot" }),
    "coinbase-perp": createCell({ source: "coinbase-perp" }),
    "binance-spot": createCell({ source: "binance-spot" }),
    "binance-perp": createCell({ source: "binance-perp" }),
  };
}

function createCell({
  source,
}: {
  readonly source: ReliabilitySource;
}): ReliabilitySourceCell {
  return {
    source,
    status: "pending",
    startPrice: null,
    startAtMs: null,
    startLagMs: null,
    endPrice: null,
    endAtMs: null,
    endLagMs: null,
    deltaBp: null,
    outcome: null,
    agreesWithPolymarket: null,
  };
}

function seedStartFromLatestTick({
  window,
  latestTicks,
  graceMs,
}: {
  readonly window: ReliabilityAssetWindow;
  readonly latestTicks: ReadonlyMap<string, ReliabilityPriceTick>;
  readonly graceMs: number;
}): void {
  for (const source of reliabilitySourceValues) {
    const tick = latestTicks.get(tickKey({ source, asset: window.asset }));
    if (tick !== undefined) {
      applyTickToWindow({ window, tick, graceMs });
    }
  }
}

async function discoverMarketForWindow({
  capture,
  window,
  signal,
  schedulePersist,
}: {
  readonly capture: ReliabilityCapturePayload;
  readonly window: ReliabilityAssetWindow;
  readonly signal: AbortSignal;
  readonly schedulePersist: () => void;
}): Promise<void> {
  try {
    const market = await discoverPolymarketMarket({
      asset: window.asset,
      windowStartUnixSeconds: Math.floor(window.windowStartMs / 1000),
      signal,
    });
    const activeWindow = capture.activeWindows.find(
      (candidate) =>
        candidate.asset === window.asset &&
        candidate.windowStartMs === window.windowStartMs,
    );
    if (activeWindow === undefined) {
      return;
    }
    if (market === null) {
      activeWindow.marketStatus = "missing";
      schedulePersist();
      return;
    }
    activeWindow.conditionId = market.market.vendorRef;
    activeWindow.marketStatus = "active";
    schedulePersist();
  } catch (error) {
    if (signal.aborted) {
      return;
    }
    window.marketStatus = "error";
    window.marketError = (error as Error).message;
    addError({
      capture,
      source: null,
      message: `${window.asset} ${window.marketSlug} discovery failed: ${(error as Error).message}`,
    });
    schedulePersist();
  }
}

function captureTick({
  capture,
  tick,
  graceMs,
}: {
  readonly capture: ReliabilityCapturePayload;
  readonly tick: ReliabilityPriceTick;
  readonly graceMs: number;
}): void {
  for (const window of capture.activeWindows) {
    if (window.asset !== tick.asset) {
      continue;
    }
    applyTickToWindow({ window, tick, graceMs });
  }
}

function applyTickToWindow({
  window,
  tick,
  graceMs,
}: {
  readonly window: ReliabilityAssetWindow;
  readonly tick: ReliabilityPriceTick;
  readonly graceMs: number;
}): void {
  const cell = window.sources[tick.source];
  if (cell.startAtMs === null && tick.receivedAtMs >= window.windowStartMs) {
    cell.startPrice = tick.price;
    cell.startAtMs = tick.receivedAtMs;
    cell.startLagMs = tick.receivedAtMs - window.windowStartMs;
  }
  if (
    cell.endAtMs === null &&
    tick.receivedAtMs >= window.windowEndMs &&
    tick.receivedAtMs <= window.windowEndMs + graceMs
  ) {
    cell.endPrice = tick.price;
    cell.endAtMs = tick.receivedAtMs;
    cell.endLagMs = tick.receivedAtMs - window.windowEndMs;
  }
}

function finalizeDueWindows({
  capture,
  nowMs,
  graceMs,
}: {
  readonly capture: ReliabilityCapturePayload;
  readonly nowMs: number;
  readonly graceMs: number;
}): readonly ReliabilityAssetWindow[] {
  const finalized: ReliabilityAssetWindow[] = [];
  const stillActive: ReliabilityAssetWindow[] = [];
  for (const window of capture.activeWindows) {
    if (nowMs < window.windowEndMs + graceMs) {
      stillActive.push(window);
      continue;
    }
    const completed = finalizeReliabilityWindow({
      window,
      finalizedAtMs: nowMs,
      graceMs,
    });
    capture.completedWindows.push(completed);
    finalized.push(completed);
  }
  capture.activeWindows = stillActive;
  return finalized;
}

function groupFinalizedByWindow({
  windows,
}: {
  readonly windows: readonly ReliabilityAssetWindow[];
}): ReadonlyArray<{
  readonly windowStartMs: number;
  readonly windows: readonly ReliabilityAssetWindow[];
}> {
  const groups = new Map<number, ReliabilityAssetWindow[]>();
  for (const window of windows) {
    const group = groups.get(window.windowStartMs) ?? [];
    group.push(window);
    groups.set(window.windowStartMs, group);
  }
  return [...groups.entries()].map(([windowStartMs, group]) => ({
    windowStartMs,
    windows: group,
  }));
}

function createSourceHealth(): ReliabilitySourceHealth[] {
  return reliabilitySourceValues.map((source) => ({
    source,
    connected: false,
    connectCount: 0,
    disconnectCount: 0,
    errorCount: 0,
    ticks: 0,
    lastTickAtMs: null,
    lastError: null,
  }));
}

function dedupeCompletedWindows({
  windows,
}: {
  readonly windows: readonly ReliabilityAssetWindow[];
}): ReliabilityAssetWindow[] {
  const byKey = new Map<string, ReliabilityAssetWindow>();
  for (const window of windows) {
    byKey.set(`${window.windowStartMs}:${window.asset}`, window);
  }
  return [...byKey.values()].sort(
    (a, b) =>
      a.windowStartMs - b.windowStartMs || a.asset.localeCompare(b.asset),
  );
}

function addError({
  capture,
  source,
  message,
}: {
  readonly capture: ReliabilityCapturePayload;
  readonly source: ReliabilitySource | null;
  readonly message: string;
}): void {
  capture.errors.push({ atMs: Date.now(), source, message });
  if (capture.errors.length > MAX_RETAINED_ERRORS) {
    capture.errors.splice(0, capture.errors.length - MAX_RETAINED_ERRORS);
  }
}

function tickKey({
  source,
  asset,
}: {
  readonly source: ReliabilitySource;
  readonly asset: Asset;
}): string {
  return `${source}:${asset}`;
}

function formatTime({ ms }: { readonly ms: number }): string {
  return new Date(ms).toISOString().slice(11, 19);
}
