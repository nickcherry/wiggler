import type {
  SurvivalRemainingMinutes,
  SurvivalSnapshot,
} from "@alea/lib/training/computeSurvivalSnapshots";
import type {
  SurvivalFilter,
  SurvivalFilterResult,
  SurvivalFilterSummary,
} from "@alea/lib/training/survivalFilters/types";
import type {
  SurvivalBucket,
  SurvivalSurface,
  SurvivalSurfaceWithCount,
} from "@alea/lib/training/types";

/**
 * Sample-count floor used when scanning the surfaces for the "best
 * improvement vs baseline" summary metric. Mirrors the renderer's
 * threshold so the summary's claim about a filter's best edge matches
 * what the operator can actually see in the table.
 *
 * Kept here (not imported from the renderer) so the compute layer has no
 * dependency on the rendering layer.
 */
const SUMMARY_MIN_SAMPLES = 300;

/**
 * Win-rate targets the summary scans for the best-improvement metric.
 * Same set the renderer's threshold table uses.
 */
const SUMMARY_TARGET_WIN_RATES: readonly number[] = [
  60, 65, 70, 75, 80, 85, 90, 95,
];

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
  const baselineThresholds = computeThresholdMatrix({ surface: baseline });

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
      baselineThresholds,
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
// Summary metrics: `bestImprovementBp` is the most negative delta (true
// or false vs baseline) across the same `(remainingMinutes, target)`
// matrix the renderer's threshold table shows. We compute the baseline
// matrix once, then diff each half against it.
// ----------------------------------------------------------------

type ThresholdMatrix = Map<
  SurvivalRemainingMinutes,
  Map<number, number | null>
>;

function computeThresholdMatrix({
  surface,
}: {
  readonly surface: SurvivalSurface;
}): ThresholdMatrix {
  const out: ThresholdMatrix = new Map();
  for (const remaining of REMAINING_VALUES) {
    const buckets = surface.byRemaining[remaining];
    const inner = new Map<number, number | null>();
    for (const target of SUMMARY_TARGET_WIN_RATES) {
      inner.set(target, firstBucketReachingTarget({ buckets, target }));
    }
    out.set(remaining, inner);
  }
  return out;
}

function firstBucketReachingTarget({
  buckets,
  target,
}: {
  readonly buckets: readonly SurvivalBucket[];
  readonly target: number;
}): number | null {
  for (const bucket of buckets) {
    if (bucket.total < SUMMARY_MIN_SAMPLES) {
      continue;
    }
    const winRate = (bucket.survived / bucket.total) * 100;
    if (winRate >= target) {
      return bucket.distanceBp;
    }
  }
  return null;
}

function computeSummary({
  counts,
  baselineThresholds,
  whenTrue,
  whenFalse,
}: {
  readonly counts: {
    readonly trueCount: number;
    readonly falseCount: number;
    readonly skipCount: number;
  };
  readonly baselineThresholds: ThresholdMatrix;
  readonly whenTrue: SurvivalSurface;
  readonly whenFalse: SurvivalSurface;
}): SurvivalFilterSummary {
  const classified = counts.trueCount + counts.falseCount;
  const occurrenceTrue = classified === 0 ? 0 : counts.trueCount / classified;
  const occurrenceFalse = classified === 0 ? 0 : counts.falseCount / classified;
  const trueThresholds = computeThresholdMatrix({ surface: whenTrue });
  const falseThresholds = computeThresholdMatrix({ surface: whenFalse });
  const bestImprovementByRemaining = {} as Record<
    SurvivalRemainingMinutes,
    { trueBp: number | null; falseBp: number | null }
  >;
  for (const remaining of REMAINING_VALUES) {
    bestImprovementByRemaining[remaining] = {
      trueBp: bestImprovementAtRemaining({
        baseline: baselineThresholds,
        half: trueThresholds,
        remaining,
      }),
      falseBp: bestImprovementAtRemaining({
        baseline: baselineThresholds,
        half: falseThresholds,
        remaining,
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
    bestImprovementBpTrue: bestImprovement({
      baseline: baselineThresholds,
      half: trueThresholds,
    }),
    bestImprovementBpFalse: bestImprovement({
      baseline: baselineThresholds,
      half: falseThresholds,
    }),
    bestImprovementByRemaining,
    score: null,
    verdict: null,
  };
}

function bestImprovementAtRemaining({
  baseline,
  half,
  remaining,
}: {
  readonly baseline: ThresholdMatrix;
  readonly half: ThresholdMatrix;
  readonly remaining: SurvivalRemainingMinutes;
}): number | null {
  const baseInner = baseline.get(remaining);
  const halfInner = half.get(remaining);
  if (baseInner === undefined || halfInner === undefined) {
    return null;
  }
  let best: number | null = null;
  for (const target of SUMMARY_TARGET_WIN_RATES) {
    const baseBp = baseInner.get(target);
    const halfBp = halfInner.get(target);
    if (
      baseBp === undefined ||
      baseBp === null ||
      halfBp === undefined ||
      halfBp === null
    ) {
      continue;
    }
    const delta = halfBp - baseBp;
    if (best === null || delta < best) {
      best = delta;
    }
  }
  return best;
}

function bestImprovement({
  baseline,
  half,
}: {
  readonly baseline: ThresholdMatrix;
  readonly half: ThresholdMatrix;
}): number | null {
  let best: number | null = null;
  for (const remaining of REMAINING_VALUES) {
    const baseInner = baseline.get(remaining);
    const halfInner = half.get(remaining);
    if (baseInner === undefined || halfInner === undefined) {
      continue;
    }
    for (const target of SUMMARY_TARGET_WIN_RATES) {
      const baseBp = baseInner.get(target);
      const halfBp = halfInner.get(target);
      if (
        baseBp === undefined ||
        baseBp === null ||
        halfBp === undefined ||
        halfBp === null
      ) {
        continue;
      }
      const delta = halfBp - baseBp;
      if (best === null || delta < best) {
        best = delta;
      }
    }
  }
  return best;
}
