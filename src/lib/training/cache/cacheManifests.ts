import type { CandleSeries } from "@alea/types/candleSeries";

/**
 * Cache manifests: structured records that uniquely identify a cached
 * payload. The cache key is a short hex hash of the manifest, so any
 * change to a field — version bump, filter id, new candle data — produces
 * a new key and the cache transparently misses.
 *
 * Each manifest also gets persisted alongside the payload so a stale or
 * corrupt cache file is self-describing on disk.
 */
export type CacheManifest =
  | SizeDistributionCacheManifest
  | SurvivalDistributionCacheManifest
  | SurvivalFilterCacheManifest;

export type SizeDistributionCacheManifest = {
  readonly kind: "size";
  readonly series: CandleSeries;
  readonly asset: string;
  /** UNIX-ms timestamp of the most recent candle in the loaded series. */
  readonly lastCandleMs5m: number;
  /** Bumped when `computeCandleSizeDistribution` semantics change. */
  readonly algoVersion: number;
};

export type SurvivalDistributionCacheManifest = {
  readonly kind: "survival";
  readonly series: CandleSeries;
  readonly asset: string;
  /** UNIX-ms timestamp of the most recent 1m candle. Drives staleness. */
  readonly lastCandleMs1m: number;
  /**
   * Most recent 5m candle. Included even though the bare survival
   * baseline doesn't read 5m, so that re-keying stays consistent with the
   * filter cache (which does need 5m for MA-20 / prev-5m context).
   */
  readonly lastCandleMs5m: number;
  /** Bumped when the snapshot enumeration's semantics change. */
  readonly pipelineVersion: number;
};

export type SurvivalFilterCacheManifest = {
  readonly kind: "filter";
  readonly series: CandleSeries;
  readonly asset: string;
  readonly lastCandleMs1m: number;
  readonly lastCandleMs5m: number;
  readonly pipelineVersion: number;
  readonly filterId: string;
  readonly filterVersion: number;
};
