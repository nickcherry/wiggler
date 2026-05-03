import { computeAllPercentiles } from "@wiggler/lib/training/computePercentiles";
import type {
  AssetSizeDistribution,
  SizePercentiles,
  YearSizePercentiles,
} from "@wiggler/lib/training/types";
import type { Asset } from "@wiggler/types/assets";
import type { Candle } from "@wiggler/types/candles";

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

  return {
    asset,
    candleCount: allBody.length,
    all: percentilesOf({ body: allBody, wick: allWick }),
    byYear: buildYearBreakdown({ byYearRaw }),
  };
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
