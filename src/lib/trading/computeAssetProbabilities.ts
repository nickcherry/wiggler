import type {
  AssetProbabilities,
  ProbabilityBucket,
  ProbabilitySurface,
  RemainingMinutes,
  SweetSpot,
} from "@alea/lib/trading/types";
import { computeSurvivalSnapshots } from "@alea/lib/training/computeSurvivalSnapshots";
import { computeSweetSpot } from "@alea/lib/training/survivalFilters/computeSweetSpot";
import { distanceFromLineAtrFilter } from "@alea/lib/training/survivalFilters/distanceFromLineAtr/filter";
import type { SurvivalSurface } from "@alea/lib/training/types";
import type { Asset } from "@alea/types/assets";
import type { Candle } from "@alea/types/candles";

/**
 * Computes the per-asset slice of the production probability table.
 *
 * Walks the historical snapshot stream once and accumulates three raw
 * surfaces in parallel: `aligned` ("decisively away" — filter true),
 * `notAligned` ("near the line" — filter false), and the unconditional
 * baseline. The unconditional baseline is needed only to compute the
 * sweet-spot bp range; it isn't persisted in the output.
 *
 * After accumulation, runs sweet-spot detection (shared with the
 * training-side `applySurvivalFilters` so the dashboard's sweet-spot
 * range and the live trader's acted-upon range stay in lockstep), and
 * filters the persisted surfaces to only include buckets within
 * `[sweetSpot.startBp, sweetSpot.endBp]`. Buckets outside the range
 * are dropped from the table — the live runtime treats a missing
 * bucket as "no signal, do not trade", which is the discipline rule
 * we want.
 *
 * Buckets thinner than `minBucketSamples` are dropped from both
 * persisted surfaces independently of the sweet-spot filter, so the
 * runtime never has to second-guess the table.
 *
 * Returns `null` when no usable windows exist (cold series, no warmup
 * data) or when the filter has no positive info gain anywhere (no
 * sweet spot — would be a signal something's wrong with the data).
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
  const global = createRawSurface();
  const allWindows = new Set<number>();
  const alignedWindows = new Set<number>();
  const notAlignedWindows = new Set<number>();
  let totalSnapshots = 0;

  for (const snapshot of computeSurvivalSnapshots({ candles1m, candles5m })) {
    const decision = distanceFromLineAtrFilter.classify(
      snapshot,
      snapshot.context,
    );
    if (decision === "skip") {
      continue;
    }
    totalSnapshots += 1;
    allWindows.add(snapshot.windowStartMs);
    accumulate({ surface: global, snapshot });
    const target = decision ? aligned : notAligned;
    (decision ? alignedWindows : notAlignedWindows).add(snapshot.windowStartMs);
    accumulate({ surface: target, snapshot });
  }

  if (allWindows.size === 0) {
    return null;
  }

  // Sweet-spot determination uses the unfiltered surfaces against the
  // unconditional baseline — exact same algorithm the training-side
  // `applySurvivalFilters` runs, so the live trader and the dashboard
  // converge on the same bp range per asset.
  const sweetSpot = computeSweetSpot({
    baseline: surfaceFromRaw({ raw: global }),
    whenTrue: surfaceFromRaw({ raw: aligned }),
    whenFalse: surfaceFromRaw({ raw: notAligned }),
    snapshotsTotal: totalSnapshots,
  });
  if (sweetSpot === null) {
    return null;
  }

  const alignedShare = alignedWindows.size / allWindows.size;
  return {
    asset,
    windowCount: allWindows.size,
    alignedWindowShare: alignedShare,
    aligned: materializeSurface({
      raw: aligned,
      minBucketSamples,
      sweetSpot,
    }),
    notAligned: materializeSurface({
      raw: notAligned,
      minBucketSamples,
      sweetSpot,
    }),
    sweetSpot,
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

/**
 * Lightweight shape adapter so the same `RawSurface` we use here can
 * feed `computeSweetSpot`, which expects `SurvivalSurface` (the
 * training-side type). Same data, different access pattern.
 */
function surfaceFromRaw({
  raw,
}: {
  readonly raw: RawSurface;
}): SurvivalSurface {
  return {
    byRemaining: {
      1: bucketsArrayFromRaw({ map: raw[1] }),
      2: bucketsArrayFromRaw({ map: raw[2] }),
      3: bucketsArrayFromRaw({ map: raw[3] }),
      4: bucketsArrayFromRaw({ map: raw[4] }),
    },
  };
}

function bucketsArrayFromRaw({
  map,
}: {
  readonly map: ReadonlyMap<number, RawBucket>;
}): readonly { distanceBp: number; total: number; survived: number }[] {
  return [...map.entries()]
    .sort(([a], [b]) => a - b)
    .map(([distanceBp, b]) => ({
      distanceBp,
      total: b.total,
      survived: b.survived,
    }));
}

function materializeSurface({
  raw,
  minBucketSamples,
  sweetSpot,
}: {
  readonly raw: RawSurface;
  readonly minBucketSamples: number;
  readonly sweetSpot: SweetSpot;
}): ProbabilitySurface {
  return {
    byRemaining: {
      1: bucketsOf({ map: raw[1], minBucketSamples, sweetSpot }),
      2: bucketsOf({ map: raw[2], minBucketSamples, sweetSpot }),
      3: bucketsOf({ map: raw[3], minBucketSamples, sweetSpot }),
      4: bucketsOf({ map: raw[4], minBucketSamples, sweetSpot }),
    },
  };
}

function bucketsOf({
  map,
  minBucketSamples,
  sweetSpot,
}: {
  readonly map: ReadonlyMap<number, RawBucket>;
  readonly minBucketSamples: number;
  readonly sweetSpot: SweetSpot;
}): readonly ProbabilityBucket[] {
  const distances = [...map.keys()].sort((a, b) => a - b);
  const out: ProbabilityBucket[] = [];
  for (const distanceBp of distances) {
    if (distanceBp < sweetSpot.startBp || distanceBp > sweetSpot.endBp) {
      continue;
    }
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
