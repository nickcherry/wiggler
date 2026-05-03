import { computeAllPercentiles } from "@alea/lib/training/computePercentiles";
import type {
  AssetSizeDistribution,
  SizeHistogram,
  SizePercentiles,
  YearSizePercentiles,
} from "@alea/lib/training/types";
import type { Asset } from "@alea/types/assets";
import type { Candle } from "@alea/types/candles";

/**
 * Histogram bin width, in the same percent-of-open units the percentile
 * arrays use: 0.01% = 1 basis point. 1 bp resolution gives a readable
 * shape at typical 5m crypto volatility (body p99 commonly lands in the
 * 10–50 bp range) without producing so many bins that the chart looks
 * spiky.
 */
const HISTOGRAM_BIN_WIDTH_PCT = 0.01;

/**
 * Per-candle metrics, expressed as percentages of the bar's open price:
 *
 *   - `body_pct = |close - open| / open * 100`
 *   - `wick_pct = (high - low)   / open * 100`
 *
 * Open is the natural denominator for "% move during the bar" — it is the
 * price at the moment the bar starts, which for live trading is the price
 * we condition any in-bar decision on.
 *
 * Candles with a non-positive open are skipped: that would mean degenerate
 * vendor data and dividing by it yields nonsense.
 */
export function computeCandleSizeDistribution({
  asset,
  candles,
}: {
  readonly asset: Asset;
  readonly candles: readonly Candle[];
}): AssetSizeDistribution | null {
  const allBody: number[] = [];
  const allWick: number[] = [];
  const byYearRaw = new Map<string, { body: number[]; wick: number[] }>();

  for (const candle of candles) {
    if (candle.open <= 0) {
      continue;
    }
    const bodyPct = (Math.abs(candle.close - candle.open) / candle.open) * 100;
    const wickPct = ((candle.high - candle.low) / candle.open) * 100;
    allBody.push(bodyPct);
    allWick.push(wickPct);
    const year = String(candle.timestamp.getUTCFullYear());
    const bucket = byYearRaw.get(year) ?? { body: [], wick: [] };
    bucket.body.push(bodyPct);
    bucket.wick.push(wickPct);
    byYearRaw.set(year, bucket);
  }

  if (allBody.length === 0) {
    return null;
  }

  const all = percentilesOf({ body: allBody, wick: allWick });
  return {
    asset,
    candleCount: allBody.length,
    all,
    histogram: buildHistogram({
      body: allBody,
      wick: allWick,
      percentiles: all,
    }),
    byYear: buildYearBreakdown({ byYearRaw }),
  };
}

/**
 * Builds a fixed-width histogram covering `[0, binCount * binWidth)` with
 * any larger value rolled into the trailing overflow slot. The chart range
 * is sized to `max(body_p99, wick_p99)` so the visible distribution always
 * captures at least 99% of each series; the rare flash-crash bars on the
 * far tail land in the overflow slot rather than stretching the x-axis.
 */
function buildHistogram({
  body,
  wick,
  percentiles,
}: {
  readonly body: readonly number[];
  readonly wick: readonly number[];
  readonly percentiles: SizePercentiles;
}): SizeHistogram {
  const bodyP99 = percentiles.body[99] ?? 0;
  const wickP99 = percentiles.wick[99] ?? 0;
  const maxPct = Math.max(bodyP99, wickP99);
  const binCount = Math.max(1, Math.ceil(maxPct / HISTOGRAM_BIN_WIDTH_PCT));
  const bodyBins = new Array<number>(binCount + 1).fill(0);
  const wickBins = new Array<number>(binCount + 1).fill(0);
  fillHistogram({ values: body, bins: bodyBins, binCount });
  fillHistogram({ values: wick, bins: wickBins, binCount });
  return {
    binWidth: HISTOGRAM_BIN_WIDTH_PCT,
    binCount,
    body: bodyBins,
    wick: wickBins,
  };
}

function fillHistogram({
  values,
  bins,
  binCount,
}: {
  readonly values: readonly number[];
  readonly bins: number[];
  readonly binCount: number;
}): void {
  for (const v of values) {
    // +1e-9 guards against float slop at exact bin boundaries — without
    // it, 0.05 / 0.01 evaluates to 4.999… and 5 bp would land in bin 4.
    // Same trick the survival code uses for distance bucketing.
    const idx = Math.floor(v / HISTOGRAM_BIN_WIDTH_PCT + 1e-9);
    const slot = idx >= binCount ? binCount : idx < 0 ? 0 : idx;
    bins[slot] = (bins[slot] ?? 0) + 1;
  }
}

function percentilesOf({
  body,
  wick,
}: {
  readonly body: readonly number[];
  readonly wick: readonly number[];
}): SizePercentiles {
  return {
    body: computeAllPercentiles({ sortedValues: [...body].sort(numericAsc) }),
    wick: computeAllPercentiles({ sortedValues: [...wick].sort(numericAsc) }),
  };
}

function buildYearBreakdown({
  byYearRaw,
}: {
  readonly byYearRaw: ReadonlyMap<string, { body: number[]; wick: number[] }>;
}): Record<string, YearSizePercentiles> {
  const out: Record<string, YearSizePercentiles> = {};
  const years = [...byYearRaw.keys()].sort();
  for (const year of years) {
    const bucket = byYearRaw.get(year);
    if (bucket === undefined || bucket.body.length === 0) {
      continue;
    }
    out[year] = {
      candleCount: bucket.body.length,
      ...percentilesOf({ body: bucket.body, wick: bucket.wick }),
    };
  }
  return out;
}

function numericAsc(a: number, b: number): number {
  return a - b;
}
