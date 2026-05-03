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
 * Per-asset distribution payload. Persisted into the JSON sidecar; the HTML
 * dashboard renders only the `all` slice and uses `candleCount` for the
 * header. `byYear` is keyed by UTC calendar year as a string ("2024" etc.)
 * so it round-trips cleanly through JSON.
 */
export type AssetSizeDistribution = {
  readonly asset: Asset;
  readonly candleCount: number;
  readonly all: SizePercentiles;
  readonly byYear: Readonly<Record<string, YearSizePercentiles>>;
};

export type TrainingDistributionsPayload = {
  readonly command: "training:distributions";
  readonly generatedAtMs: number;
  readonly series: CandleSeries;
  readonly assets: readonly AssetSizeDistribution[];
};
