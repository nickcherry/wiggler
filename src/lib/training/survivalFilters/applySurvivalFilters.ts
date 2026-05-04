import type {
  SurvivalRemainingMinutes,
  SurvivalSnapshot,
} from "@alea/lib/training/computeSurvivalSnapshots";
import type {
  SurvivalFilter,
  SurvivalFilterResult,
  SurvivalFilterSummary,
  SurvivalScore,
} from "@alea/lib/training/survivalFilters/types";
import type {
  SurvivalBucket,
  SurvivalSurface,
  SurvivalSurfaceWithCount,
} from "@alea/lib/training/types";

/**
 * Sample-count floor used when comparing a half's bucket vs baseline's
 * bucket: both must clear this floor for the bucket's pp delta to count
 * toward the score. Mirrors the renderer's threshold so the score
 * matches what the operator can actually see in the chart.
 *
 * Kept here (not imported from the renderer) so the compute layer has
 * no dependency on the rendering layer.
 */
const SUMMARY_MIN_SAMPLES = 300;

const REMAINING_VALUES: readonly SurvivalRemainingMinutes[] = [4, 3, 2, 1];

/**
 * Single-pass aggregator: walks the snapshot stream once, accumulates the
 * baseline surface (with per-year breakdown), and for each filter
 * accumulates its `whenTrue` and `whenFalse` surfaces. Returns the
 * baseline + byYear plus one `SurvivalFilterResult` per filter so callers
 * don't have to re-iterate the stream just to derive the per-year
 * breakdown.
 *
 * Memory: surfaces are sparse-by-distance (one entry per observed bp
 * bucket per remaining-minutes slot), so per-filter cost is bounded by
 * the bp range × 4 × 3 ≈ a few hundred entries. Processing 1.2M
 * snapshots is a single linear sweep.
 */
export function applySurvivalFilters({
  snapshots,
  filters,
}: {
  readonly snapshots: Iterable<SurvivalSnapshot>;
  readonly filters: readonly SurvivalFilter[];
}): {
  readonly baseline: SurvivalSurfaceWithCount;
  readonly baselineByYear: Readonly<Record<string, SurvivalSurfaceWithCount>>;
  readonly perFilter: readonly SurvivalFilterResult[];
} {
  const baselineRaw = createRawSurface();
  const byYearRaw = new Map<string, RawSurface>();
  const yearWindows = new Map<string, Set<number>>();
  const perFilterRaw = filters.map(() => ({
    whenTrue: createRawSurface(),
    whenFalse: createRawSurface(),
    counts: { trueCount: 0, falseCount: 0, skipCount: 0 },
  }));
  // Track distinct windows separately from snapshots: each window
  // contributes exactly four snapshots, but we report `windowCount` on
  // the surface so the per-section header reads consistently with the
  // baseline section.
  const baselineWindows = new Set<number>();
  const filterWindowCounts = filters.map(() => ({
    trueWindows: new Set<number>(),
    falseWindows: new Set<number>(),
  }));

  for (const snapshot of snapshots) {
    baselineWindows.add(snapshot.windowStartMs);
    record({
      raw: baselineRaw,
      remaining: snapshot.remaining,
      distanceBp: snapshot.distanceBp,
      survived: snapshot.survived,
    });
    let yearRaw = byYearRaw.get(snapshot.year);
    if (yearRaw === undefined) {
      yearRaw = createRawSurface();
      byYearRaw.set(snapshot.year, yearRaw);
    }
    record({
      raw: yearRaw,
      remaining: snapshot.remaining,
      distanceBp: snapshot.distanceBp,
      survived: snapshot.survived,
    });
    let yearWindowSet = yearWindows.get(snapshot.year);
    if (yearWindowSet === undefined) {
      yearWindowSet = new Set<number>();
      yearWindows.set(snapshot.year, yearWindowSet);
    }
    yearWindowSet.add(snapshot.windowStartMs);
    for (let i = 0; i < filters.length; i += 1) {
      const filter = filters[i];
      const slot = perFilterRaw[i];
      const windowSet = filterWindowCounts[i];
      if (
        filter === undefined ||
        slot === undefined ||
        windowSet === undefined
      ) {
        continue;
      }
      const decision = filter.classify(snapshot, snapshot.context);
      if (decision === "skip") {
        slot.counts.skipCount += 1;
        continue;
      }
      if (decision) {
        slot.counts.trueCount += 1;
        windowSet.trueWindows.add(snapshot.windowStartMs);
        record({
          raw: slot.whenTrue,
          remaining: snapshot.remaining,
          distanceBp: snapshot.distanceBp,
          survived: snapshot.survived,
        });
      } else {
        slot.counts.falseCount += 1;
        windowSet.falseWindows.add(snapshot.windowStartMs);
        record({
          raw: slot.whenFalse,
          remaining: snapshot.remaining,
          distanceBp: snapshot.distanceBp,
          survived: snapshot.survived,
        });
      }
    }
  }

  const baseline: SurvivalSurfaceWithCount = {
    windowCount: baselineWindows.size,
    ...materializeSurface({ raw: baselineRaw }),
  };
  const baselineByYear: Record<string, SurvivalSurfaceWithCount> = {};
  for (const year of [...byYearRaw.keys()].sort()) {
    const raw = byYearRaw.get(year);
    const windows = yearWindows.get(year);
    if (raw === undefined || windows === undefined || windows.size === 0) {
      continue;
    }
    baselineByYear[year] = {
      windowCount: windows.size,
      ...materializeSurface({ raw }),
    };
  }
  const perFilter: SurvivalFilterResult[] = [];
  for (let i = 0; i < filters.length; i += 1) {
    const filter = filters[i];
    const slot = perFilterRaw[i];
    const windowSet = filterWindowCounts[i];
    if (filter === undefined || slot === undefined || windowSet === undefined) {
      continue;
    }
    const whenTrue: SurvivalSurfaceWithCount = {
      windowCount: windowSet.trueWindows.size,
      ...materializeSurface({ raw: slot.whenTrue }),
    };
    const whenFalse: SurvivalSurfaceWithCount = {
      windowCount: windowSet.falseWindows.size,
      ...materializeSurface({ raw: slot.whenFalse }),
    };
    const summary = computeSummary({
      counts: slot.counts,
      baseline,
      whenTrue,
      whenFalse,
    });
    perFilter.push({
      id: filter.id,
      displayName: filter.displayName,
      description: filter.description,
      trueLabel: filter.trueLabel,
      falseLabel: filter.falseLabel,
      baseline,
      whenTrue,
      whenFalse,
      summary,
    });
  }

  return { baseline, baselineByYear, perFilter };
}

// ----------------------------------------------------------------
// Bucket accumulation (shared with computeSurvivalDistribution.ts; copied
// rather than imported because computeSurvivalDistribution is being
// refactored to delegate to this module — we don't want a back-edge).
// ----------------------------------------------------------------

type RawBucket = { total: number; survived: number };
type RawSurface = Record<SurvivalRemainingMinutes, Map<number, RawBucket>>;

function createRawSurface(): RawSurface {
  return {
    1: new Map(),
    2: new Map(),
    3: new Map(),
    4: new Map(),
  };
}

function record({
  raw,
  remaining,
  distanceBp,
  survived,
}: {
  readonly raw: RawSurface;
  readonly remaining: SurvivalRemainingMinutes;
  readonly distanceBp: number;
  readonly survived: boolean;
}): void {
  const bucket = raw[remaining].get(distanceBp) ?? { total: 0, survived: 0 };
  bucket.total += 1;
  if (survived) {
    bucket.survived += 1;
  }
  raw[remaining].set(distanceBp, bucket);
}

function materializeSurface({
  raw,
}: {
  readonly raw: RawSurface;
}): SurvivalSurface {
  return {
    byRemaining: {
      1: bucketsOf({ map: raw[1] }),
      2: bucketsOf({ map: raw[2] }),
      3: bucketsOf({ map: raw[3] }),
      4: bucketsOf({ map: raw[4] }),
    },
  };
}

function bucketsOf({
  map,
}: {
  readonly map: ReadonlyMap<number, RawBucket>;
}): readonly SurvivalBucket[] {
  const distances = [...map.keys()].sort((a, b) => a - b);
  return distances.map((distanceBp) => {
    const bucket = map.get(distanceBp);
    if (bucket === undefined) {
      throw new Error("unreachable: distance key without bucket");
    }
    return {
      distanceBp,
      total: bucket.total,
      survived: bucket.survived,
    };
  });
}

// ----------------------------------------------------------------
// Score: signed area between the half's win-rate line and the
// baseline's win-rate line, integrated over distance. Computed per
// (remaining, half). See SurvivalScore docs for the convention.
// ----------------------------------------------------------------

function computeSummary({
  counts,
  baseline,
  whenTrue,
  whenFalse,
}: {
  readonly counts: {
    readonly trueCount: number;
    readonly falseCount: number;
    readonly skipCount: number;
  };
  readonly baseline: SurvivalSurface;
  readonly whenTrue: SurvivalSurface;
  readonly whenFalse: SurvivalSurface;
}): SurvivalFilterSummary {
  const classified = counts.trueCount + counts.falseCount;
  const occurrenceTrue = classified === 0 ? 0 : counts.trueCount / classified;
  const occurrenceFalse = classified === 0 ? 0 : counts.falseCount / classified;
  const scoresByRemaining = {} as Record<
    SurvivalRemainingMinutes,
    { true: SurvivalScore; false: SurvivalScore }
  >;
  for (const remaining of REMAINING_VALUES) {
    const baselineBuckets = baseline.byRemaining[remaining];
    scoresByRemaining[remaining] = {
      true: scoreHalfVsBaseline({
        halfBuckets: whenTrue.byRemaining[remaining],
        baselineBuckets,
      }),
      false: scoreHalfVsBaseline({
        halfBuckets: whenFalse.byRemaining[remaining],
        baselineBuckets,
      }),
    };
  }
  return {
    snapshotsTotal: classified + counts.skipCount,
    snapshotsTrue: counts.trueCount,
    snapshotsFalse: counts.falseCount,
    snapshotsSkipped: counts.skipCount,
    occurrenceTrue,
    occurrenceFalse,
    scoresByRemaining,
  };
}

/**
 * Sums per-bucket pp deltas weighted by sample reliability so dense
 * (low-distance) buckets dominate sparse (long-tail) ones. Without
 * weighting, a thinly-supported far-tail bucket carried as much weight
 * as a densely-sampled near-line bucket — visually obvious wrong from
 * the delta-chart density-fill, where the long tail goes faint.
 *
 * Per-bucket weight = `min(halfCount, baselineCount)`. Baseline always
 * has at least as many samples as either half (baseline = trueHalf +
 * falseHalf), so this collapses to `halfCount` in practice; written as
 * the min so a future filter that doesn't preserve that invariant
 * (skip-heavy filters where baseline can be smaller in some bucket)
 * still computes correctly.
 *
 * The score stays in roughly the same scale as the unweighted version
 * by normalizing through the mean: `score = weightedMeanDelta *
 * coverageBp`. So a uniformly-sampled filter scores the same as
 * before; a sparse-tail-driven score that previously inflated now
 * shrinks. Decorative max/min stay unweighted — they describe
 * single-bucket extremes, not aggregate signal.
 *
 * Buckets where either side is below `SUMMARY_MIN_SAMPLES` are skipped
 * entirely (zero weight, no coverage credit) — the floor still applies
 * before weighting.
 */
function scoreHalfVsBaseline({
  halfBuckets,
  baselineBuckets,
}: {
  readonly halfBuckets: readonly SurvivalBucket[];
  readonly baselineBuckets: readonly SurvivalBucket[];
}): SurvivalScore {
  const baselineByDistance = new Map<number, SurvivalBucket>();
  for (const b of baselineBuckets) {
    baselineByDistance.set(b.distanceBp, b);
  }
  let weightedDeltaSum = 0;
  let weightSum = 0;
  let coverageBp = 0;
  let maxDeltaPp: number | null = null;
  let minDeltaPp: number | null = null;
  for (const half of halfBuckets) {
    if (half.total < SUMMARY_MIN_SAMPLES) {
      continue;
    }
    const base = baselineByDistance.get(half.distanceBp);
    if (base === undefined || base.total < SUMMARY_MIN_SAMPLES) {
      continue;
    }
    const halfWinRate = (half.survived / half.total) * 100;
    const baseWinRate = (base.survived / base.total) * 100;
    const deltaPp = halfWinRate - baseWinRate;
    const weight = Math.min(half.total, base.total);
    weightedDeltaSum += deltaPp * weight;
    weightSum += weight;
    coverageBp += 1;
    if (maxDeltaPp === null || deltaPp > maxDeltaPp) {
      maxDeltaPp = deltaPp;
    }
    if (minDeltaPp === null || deltaPp < minDeltaPp) {
      minDeltaPp = deltaPp;
    }
  }
  const weightedMeanDelta = weightSum === 0 ? 0 : weightedDeltaSum / weightSum;
  const score = weightedMeanDelta * coverageBp;
  return {
    score,
    coverageBp,
    meanDeltaPp: coverageBp === 0 ? null : weightedMeanDelta,
    maxDeltaPp,
    minDeltaPp,
  };
}
