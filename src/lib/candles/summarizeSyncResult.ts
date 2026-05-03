import type { SyncCandlesResult } from "@alea/lib/candles/syncCandles";

export type SyncCandlesPageStats = {
  readonly count: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
};

/**
 * Reduces per-page latency samples to mean/p50/p95/max for human reporting.
 */
export function summarizeSyncResult({
  result,
}: {
  readonly result: SyncCandlesResult;
}): SyncCandlesPageStats {
  const samples = result.pages.map((page) => page.elapsedMs);
  if (samples.length === 0) {
    return { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((total, value) => total + value, 0);

  return {
    count: samples.length,
    meanMs: sum / samples.length,
    p50Ms: percentile({ sorted, fraction: 0.5 }),
    p95Ms: percentile({ sorted, fraction: 0.95 }),
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

function percentile({
  sorted,
  fraction,
}: {
  readonly sorted: readonly number[];
  readonly fraction: number;
}): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(sorted.length * fraction)),
  );
  return sorted[index] ?? 0;
}
