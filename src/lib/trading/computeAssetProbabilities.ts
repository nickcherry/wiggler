import type {
  AssetProbabilities,
  ProbabilityBucket,
  ProbabilitySurface,
  RemainingMinutes,
} from "@alea/lib/trading/types";
import { computeSurvivalSnapshots } from "@alea/lib/training/computeSurvivalSnapshots";
import { ema505mAlignmentFilter } from "@alea/lib/training/survivalFilters/ema505mAlignment/filter";
import type { Asset } from "@alea/types/assets";
import type { Candle } from "@alea/types/candles";

/**
 * Computes the per-asset slice of the production probability table by
 * walking the historical snapshot stream once and accumulating
 * `(aligned, remaining, distanceBp) → (samples, survived)` totals.
 *
 * The survival snapshot pipeline is reused as-is — same windowing, same
 * distance bucketing, same lookback context — but the rest of the
 * training framework (multi-filter overlays, scoring, JSON sidecars,
 * cache layers) is bypassed entirely. This keeps the live trader's
 * data dependency narrow: one filter, one numeric output per bucket.
 *
 * Buckets thinner than `minBucketSamples` are dropped from both
 * surfaces so the runtime never has to second-guess the table.
 *
 * Returns `null` when no usable windows exist for this asset (cold
 * series, insufficient EMA warm-up, etc.).
 */
export function computeAssetProbabilities({
  asset,
  candles1m,
  candles5m,
  minBucketSamples,
}: {
  readonly asset: Asset;
  readonly candles1m: readonly Candle[];
  readonly candles5m: readonly Candle[];
  readonly minBucketSamples: number;
}): AssetProbabilities | null {
  const aligned = createRawSurface();
  const notAligned = createRawSurface();
  const allWindows = new Set<number>();
  const alignedWindows = new Set<number>();
  const notAlignedWindows = new Set<number>();

  for (const snapshot of computeSurvivalSnapshots({ candles1m, candles5m })) {
    const decision = ema505mAlignmentFilter.classify(
      snapshot,
      snapshot.context,
    );
    if (decision === "skip") {
      continue;
    }
    allWindows.add(snapshot.windowStartMs);
    const target = decision ? aligned : notAligned;
    (decision ? alignedWindows : notAlignedWindows).add(snapshot.windowStartMs);
    accumulate({ surface: target, snapshot });
  }

  if (allWindows.size === 0) {
    return null;
  }

  const alignedShare = alignedWindows.size / allWindows.size;

  return {
    asset,
    windowCount: allWindows.size,
    alignedWindowShare: alignedShare,
    aligned: materializeSurface({ raw: aligned, minBucketSamples }),
    notAligned: materializeSurface({ raw: notAligned, minBucketSamples }),
  };
}

type RawBucket = { total: number; survived: number };
type RawSurface = Record<RemainingMinutes, Map<number, RawBucket>>;

function createRawSurface(): RawSurface {
  return {
    1: new Map(),
    2: new Map(),
    3: new Map(),
    4: new Map(),
  };
}

function accumulate({
  surface,
  snapshot,
}: {
  readonly surface: RawSurface;
  readonly snapshot: {
    readonly remaining: RemainingMinutes;
    readonly distanceBp: number;
    readonly survived: boolean;
  };
}): void {
  const bucket = surface[snapshot.remaining].get(snapshot.distanceBp) ?? {
    total: 0,
    survived: 0,
  };
  bucket.total += 1;
  if (snapshot.survived) {
    bucket.survived += 1;
  }
  surface[snapshot.remaining].set(snapshot.distanceBp, bucket);
}

function materializeSurface({
  raw,
  minBucketSamples,
}: {
  readonly raw: RawSurface;
  readonly minBucketSamples: number;
}): ProbabilitySurface {
  return {
    byRemaining: {
      1: bucketsOf({ map: raw[1], minBucketSamples }),
      2: bucketsOf({ map: raw[2], minBucketSamples }),
      3: bucketsOf({ map: raw[3], minBucketSamples }),
      4: bucketsOf({ map: raw[4], minBucketSamples }),
    },
  };
}

function bucketsOf({
  map,
  minBucketSamples,
}: {
  readonly map: ReadonlyMap<number, RawBucket>;
  readonly minBucketSamples: number;
}): readonly ProbabilityBucket[] {
  const distances = [...map.keys()].sort((a, b) => a - b);
  const out: ProbabilityBucket[] = [];
  for (const distanceBp of distances) {
    const bucket = map.get(distanceBp);
    if (bucket === undefined || bucket.total < minBucketSamples) {
      continue;
    }
    out.push({
      distanceBp,
      samples: bucket.total,
      probability: bucket.survived / bucket.total,
    });
  }
  return out;
}
