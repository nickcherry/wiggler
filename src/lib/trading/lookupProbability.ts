import type {
  AssetProbabilities,
  ProbabilityBucket,
  ProbabilitySurface,
  ProbabilityTable,
  RemainingMinutes,
} from "@alea/lib/trading/types";
import type { Asset } from "@alea/types/assets";

export type ProbabilityLookup = {
  readonly distanceBp: number;
  readonly probability: number;
  readonly samples: number;
};

/**
 * Reads a single bucket out of the table for the given live snapshot.
 *
 * Inputs:
 *   - `aligned` — legacy surface name for the active filter's true
 *     half. Today this means the snapshot is "decisively away" from
 *     the line: `|price - line| >= 0.5 * ATR-14`, matching
 *     `distance_from_line_atr`.
 *   - `remaining` — minutes left in the window, floored to one of
 *     {1,2,3,4} by the live runner.
 *   - `distanceBp` — `floor(|price - line| / line * 10000)`, matching
 *     the training pipeline's bucketing.
 *
 * Returns the bucket that exactly matches, or `null` if the table has
 * no observations at this `(remaining, distanceBp)` (either because the
 * bucket was below the sample floor at generation time, or because the
 * live distance has moved past the largest bucket the training data ever
 * saw). The runtime treats `null` as "no signal, do not trade."
 *
 * Deliberately does NOT interpolate or fall back to a neighbour bucket.
 * Falling back would silently extend the model into untrained territory;
 * we'd rather skip the trade.
 */
export function lookupProbability({
  table,
  asset,
  aligned,
  remaining,
  distanceBp,
}: {
  readonly table: ProbabilityTable;
  readonly asset: Asset;
  readonly aligned: boolean;
  readonly remaining: RemainingMinutes;
  readonly distanceBp: number;
}): ProbabilityLookup | null {
  const assetEntry = findAsset({ table, asset });
  if (assetEntry === null) {
    return null;
  }
  const surface = aligned ? assetEntry.aligned : assetEntry.notAligned;
  return findBucket({ surface, remaining, distanceBp });
}

function findAsset({
  table,
  asset,
}: {
  readonly table: ProbabilityTable;
  readonly asset: Asset;
}): AssetProbabilities | null {
  for (const entry of table.assets) {
    if (entry.asset === asset) {
      return entry;
    }
  }
  return null;
}

function findBucket({
  surface,
  remaining,
  distanceBp,
}: {
  readonly surface: ProbabilitySurface;
  readonly remaining: RemainingMinutes;
  readonly distanceBp: number;
}): ProbabilityLookup | null {
  const buckets = surface.byRemaining[remaining];
  // Buckets are sorted ascending by `distanceBp` and contiguous gaps
  // are simply absent — a linear scan is cheap (a few hundred entries
  // per surface at most) and easier to read than a bisect.
  for (const bucket of buckets) {
    if (bucket.distanceBp === distanceBp) {
      return bucketToLookup({ bucket });
    }
    if (bucket.distanceBp > distanceBp) {
      return null;
    }
  }
  return null;
}

function bucketToLookup({
  bucket,
}: {
  readonly bucket: ProbabilityBucket;
}): ProbabilityLookup {
  return {
    distanceBp: bucket.distanceBp,
    probability: bucket.probability,
    samples: bucket.samples,
  };
}
