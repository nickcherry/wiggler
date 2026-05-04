import type { Asset } from "@alea/types/assets";
import type { CandleSeries } from "@alea/types/candleSeries";

/**
 * Per-percentile values for the two metrics the candle-size analysis
 * computes:
 *
 *   - `body[p]` = the p-th percentile value of `|close - open| / open * 100`
 *   - `wick[p]` = the p-th percentile value of `(high - low) / open * 100`
 *
 * Both arrays have length 101: index `p` is the percentile-p value, with
 * p=0 the minimum, p=100 the maximum, and p=50 the median.
 */
export type SizePercentiles = {
  readonly body: readonly number[];
  readonly wick: readonly number[];
};

export type YearSizePercentiles = SizePercentiles & {
  readonly candleCount: number;
};

/**
 * Body/wick frequency distribution as a fixed-width histogram. Bin `i`
 * counts candles with size in `[i * binWidth, (i + 1) * binWidth)` (units
 * match the percentile arrays — percent of open price). The final entry of
 * each `body`/`wick` array — at index `binCount` — is the overflow count
 * for any candle past the chart range, so the arrays sum to the total
 * candle count even when the right tail is clipped from the visualization.
 */
export type SizeHistogram = {
  readonly binWidth: number;
  readonly binCount: number;
  readonly body: readonly number[];
  readonly wick: readonly number[];
};

/**
 * Per-asset distribution payload. Persisted into the JSON sidecar; the HTML
 * dashboard renders the `histogram` (chart) and the `all` percentiles
 * (table tail) and uses `candleCount` for the header. `byYear` is keyed by
 * UTC calendar year as a string ("2024" etc.) so it round-trips cleanly
 * through JSON.
 */
export type AssetSizeDistribution = {
  readonly asset: Asset;
  readonly candleCount: number;
  readonly all: SizePercentiles;
  readonly histogram: SizeHistogram;
  readonly byYear: Readonly<Record<string, YearSizePercentiles>>;
};

/**
 * Minutes remaining in the 5m window at the moment of the snapshot. The
 * survival analysis takes one snapshot per 1m boundary inside each window
 * (at +1m..+4m), so the only valid values are 1, 2, 3, 4.
 */
export type SurvivalRemainingMinutes = 1 | 2 | 3 | 4;

/**
 * One bucket of the survival surface: how often the side currently leading
 * at this `(remainingMinutes, distanceBp)` pair went on to win the 5m
 * window. `distanceBp` is the integer floor of the absolute distance from
 * the 5m line in basis points; `total` is the snapshot count, `survived`
 * the count whose currentSide matched finalSide.
 */
export type SurvivalBucket = {
  readonly distanceBp: number;
  readonly total: number;
  readonly survived: number;
};

/**
 * Per-asset survival distribution. `byRemaining` is keyed by remaining
 * minutes; each value is an array of buckets sorted ascending by
 * `distanceBp` with no gaps suppressed (zero-sample buckets are simply
 * absent). `windowCount` is the number of valid 5m windows used (each
 * contributes 4 snapshots, one per remaining-minutes bucket).
 *
 * `byYear` keys windows by the UTC year of their start timestamp.
 */
export type AssetSurvivalDistribution = {
  readonly asset: Asset;
  readonly windowCount: number;
  readonly all: SurvivalSurface;
  readonly byYear: Readonly<Record<string, SurvivalSurfaceWithCount>>;
};

export type SurvivalSurface = {
  readonly byRemaining: Readonly<
    Record<SurvivalRemainingMinutes, readonly SurvivalBucket[]>
  >;
};

export type SurvivalSurfaceWithCount = SurvivalSurface & {
  readonly windowCount: number;
};

/**
 * Per-asset bundle of binary filter results. Each entry corresponds to
 * one filter in the registry, with the same baseline + true/false +
 * summary shape so the renderer can iterate them generically.
 *
 * The structural type is declared in
 * `survivalFilters/types.ts` (close to the framework code) and re-imported
 * here as an opaque payload field — `types.ts` stays the canonical home
 * for the JSON-sidecar shape without needing to know the filter
 * framework's internals.
 */
export type AssetSurvivalFilters = {
  readonly asset: Asset;
  readonly results: readonly SurvivalFilterResultPayload[];
};

/**
 * Wire-shape of one filter result on disk. Mirrors
 * `SurvivalFilterResult` from the filter framework. We re-declare it here
 * instead of importing to keep this module dependency-free of the filter
 * framework (and to avoid a load-order cycle when the framework grows
 * its own helper types).
 */
export type SurvivalFilterResultPayload = {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly trueLabel: string;
  readonly falseLabel: string;
  readonly baseline: SurvivalSurfaceWithCount;
  readonly whenTrue: SurvivalSurfaceWithCount;
  readonly whenFalse: SurvivalSurfaceWithCount;
  readonly summary: SurvivalFilterSummaryPayload;
};

export type SurvivalScorePayload = {
  readonly score: number;
  readonly coverageBp: number;
  readonly meanDeltaPp: number | null;
  readonly maxDeltaPp: number | null;
  readonly minDeltaPp: number | null;
};

export type SurvivalFilterSummaryPayload = {
  readonly snapshotsTotal: number;
  readonly snapshotsTrue: number;
  readonly snapshotsFalse: number;
  readonly snapshotsSkipped: number;
  readonly occurrenceTrue: number;
  readonly occurrenceFalse: number;
  /**
   * Per-`(remaining-minutes, half)` score against baseline. Positive =
   * filter half outperforms baseline (do-trade signal); negative =
   * filter half underperforms (avoid-trade signal); near-zero =
   * indistinguishable from baseline.
   */
  readonly scoresByRemaining: Readonly<
    Record<
      SurvivalRemainingMinutes,
      {
        readonly true: SurvivalScorePayload;
        readonly false: SurvivalScorePayload;
      }
    >
  >;
};

export type TrainingDistributionsPayload = {
  readonly command: "training:distributions";
  readonly generatedAtMs: number;
  readonly series: CandleSeries;
  readonly assets: readonly AssetSizeDistribution[];
  readonly survival: readonly AssetSurvivalDistribution[];
  readonly survivalFilters: readonly AssetSurvivalFilters[];
};
