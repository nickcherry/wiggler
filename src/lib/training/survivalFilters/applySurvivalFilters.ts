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
  const snapshotsTotal = classified + counts.skipCount;
  const occurrenceTrue = classified === 0 ? 0 : counts.trueCount / classified;
  const occurrenceFalse = classified === 0 ? 0 : counts.falseCount / classified;
  const scoresByRemaining = {} as Record<
    SurvivalRemainingMinutes,
    { true: SurvivalScore; false: SurvivalScore }
  >;
  // Calibration score numerator: total nats saved across every counted
  // (remaining, half, distance) cell, vs the *global* unconditional
  // baseline at the same bucket. Denominator is `snapshotsTotal`
  // (including skipped) — skipped snapshots contribute zero, so a
  // high-skip filter pays a coverage cost in the headline score even
  // when its calibration-on-kept is excellent. Per-rem contributions
  // are tracked separately so the dashboard can show each rem's share
  // of the headline score.
  let totalNatsSavedVsGlobal = 0;
  const natsSavedByRemaining = {} as Record<SurvivalRemainingMinutes, number>;
  for (const remaining of REMAINING_VALUES) {
    // Filter-conditioned baseline: for this filter only, the reference
    // is the union of its kept halves at each bucket. Snapshots the
    // filter `skip`ped never enter this reference, so the per-cell
    // score answers "which side of the split is more informative?"
    // rather than "is this filter better than not filtering?" — the
    // latter was biased by skip-selection (a high-skip filter could be
    // punished simply for selecting a hard subset of snapshots, even
    // when its split was genuinely informative within that subset).
    const conditionedBaseline = sumSurvivalBuckets({
      a: whenTrue.byRemaining[remaining],
      b: whenFalse.byRemaining[remaining],
    });
    scoresByRemaining[remaining] = {
      true: scoreHalfVsBaseline({
        halfBuckets: whenTrue.byRemaining[remaining],
        otherHalfBuckets: whenFalse.byRemaining[remaining],
        baselineBuckets: conditionedBaseline,
      }),
      false: scoreHalfVsBaseline({
        halfBuckets: whenFalse.byRemaining[remaining],
        otherHalfBuckets: whenTrue.byRemaining[remaining],
        baselineBuckets: conditionedBaseline,
      }),
    };
    // Per-half nats saved vs the global baseline at the same bucket.
    // We sum here rather than reuse `scoreHalfVsBaseline` because
    // there we score against the conditioned baseline (different
    // semantics); the calibration headline needs the unconditional
    // reference.
    const remTrueNats = natsSavedVsGlobal({
      halfBuckets: whenTrue.byRemaining[remaining],
      globalBuckets: baseline.byRemaining[remaining],
    });
    const remFalseNats = natsSavedVsGlobal({
      halfBuckets: whenFalse.byRemaining[remaining],
      globalBuckets: baseline.byRemaining[remaining],
    });
    natsSavedByRemaining[remaining] = remTrueNats + remFalseNats;
    totalNatsSavedVsGlobal += natsSavedByRemaining[remaining];
  }
  const calibrationScore =
    snapshotsTotal === 0 ? 0 : totalNatsSavedVsGlobal / snapshotsTotal;
  const calibrationScoreByRemaining = {} as Record<
    SurvivalRemainingMinutes,
    number
  >;
  for (const remaining of REMAINING_VALUES) {
    calibrationScoreByRemaining[remaining] =
      snapshotsTotal === 0
        ? 0
        : natsSavedByRemaining[remaining] / snapshotsTotal;
  }
  return {
    snapshotsTotal,
    snapshotsTrue: counts.trueCount,
    snapshotsFalse: counts.falseCount,
    snapshotsSkipped: counts.skipCount,
    occurrenceTrue,
    occurrenceFalse,
    calibrationScore,
    calibrationScoreByRemaining,
    scoresByRemaining,
  };
}

/**
 * Sums per-bucket information gain (nats saved) for one half against
 * the global baseline at the same bucket. Skips below-floor buckets
 * — we don't trust those rates enough to count their predictions.
 */
function natsSavedVsGlobal({
  halfBuckets,
  globalBuckets,
}: {
  readonly halfBuckets: readonly SurvivalBucket[];
  readonly globalBuckets: readonly SurvivalBucket[];
}): number {
  const globalByDistance = new Map<number, SurvivalBucket>();
  for (const b of globalBuckets) {
    globalByDistance.set(b.distanceBp, b);
  }
  let total = 0;
  for (const half of halfBuckets) {
    if (half.total < SUMMARY_MIN_SAMPLES) {
      continue;
    }
    const global = globalByDistance.get(half.distanceBp);
    if (global === undefined || global.total < SUMMARY_MIN_SAMPLES) {
      continue;
    }
    const halfP = clampProb(half.survived / half.total);
    const globalP = clampProb(global.survived / global.total);
    const survived = half.survived;
    const failed = half.total - half.survived;
    const halfLogLoss =
      -survived * Math.log(halfP) - failed * Math.log(1 - halfP);
    const globalLogLoss =
      -survived * Math.log(globalP) - failed * Math.log(1 - globalP);
    total += globalLogLoss - halfLogLoss;
  }
  return total;
}

function sumSurvivalBuckets({
  a,
  b,
}: {
  readonly a: readonly SurvivalBucket[];
  readonly b: readonly SurvivalBucket[];
}): readonly SurvivalBucket[] {
  const merged = new Map<number, { total: number; survived: number }>();
  for (const bucket of a) {
    merged.set(bucket.distanceBp, {
      total: bucket.total,
      survived: bucket.survived,
    });
  }
  for (const bucket of b) {
    const existing = merged.get(bucket.distanceBp);
    if (existing === undefined) {
      merged.set(bucket.distanceBp, {
        total: bucket.total,
        survived: bucket.survived,
      });
    } else {
      existing.total += bucket.total;
      existing.survived += bucket.survived;
    }
  }
  return [...merged.entries()]
    .sort(([x], [y]) => x - y)
    .map(([distanceBp, { total, survived }]) => ({
      distanceBp,
      total,
      survived,
    }));
}

/**
 * Sums per-bucket pp deltas weighted by sample reliability so dense
 * (low-distance) buckets dominate sparse (long-tail) ones. Without
 * weighting, a thinly-supported far-tail bucket carried as much weight
 * as a densely-sampled near-line bucket — visually obvious wrong from
 * the delta-chart density-fill, where the long tail goes faint.
 *
 * Per-bucket weight = `halfCount` (the half being scored). Now that the
 * baseline is the filter-conditioned reference (trueHalf + falseHalf
 * summed), it always has more samples than either half by construction,
 * so the weight is gated by the half itself.
 *
 * The score stays in roughly the same scale as the unweighted version
 * by normalizing through the mean: `score = weightedMeanDelta *
 * coverageBp`. So a uniformly-sampled filter scores the same as
 * before; a sparse-tail-driven score that previously inflated now
 * shrinks. Decorative max/min stay unweighted — they describe
 * single-bucket extremes, not aggregate signal.
 *
 * Floor rule: a bucket counts only when BOTH halves clear
 * `SUMMARY_MIN_SAMPLES`. The conditioned baseline at this bucket is the
 * sum of the two halves, so a noisy other-half would feed a noisy
 * reference back into the comparison — we'd rather drop the bucket than
 * score against a soft baseline. (The half being scored also has to
 * clear the floor on its own, naturally.)
 */
// Clamp probabilities away from {0, 1} so log-loss stays finite when a
// bucket happens to be unanimous. 1e-9 is well below any realistic
// granularity our win-rates can resolve at.
const PROB_EPSILON = 1e-9;

function scoreHalfVsBaseline({
  halfBuckets,
  otherHalfBuckets,
  baselineBuckets,
}: {
  readonly halfBuckets: readonly SurvivalBucket[];
  readonly otherHalfBuckets: readonly SurvivalBucket[];
  readonly baselineBuckets: readonly SurvivalBucket[];
}): SurvivalScore {
  const baselineByDistance = new Map<number, SurvivalBucket>();
  for (const b of baselineBuckets) {
    baselineByDistance.set(b.distanceBp, b);
  }
  const otherHalfByDistance = new Map<number, SurvivalBucket>();
  for (const b of otherHalfBuckets) {
    otherHalfByDistance.set(b.distanceBp, b);
  }
  // First pass: collect (deltaPp, weight, half-bucket logloss diff) per
  // counted bucket. We need two passes because Sharpe wants the
  // weighted variance, which is cheapest to compute given the mean.
  type Counted = {
    readonly deltaPp: number;
    readonly weight: number;
    readonly logLossSavedNats: number;
  };
  const counted: Counted[] = [];
  let maxDeltaPp: number | null = null;
  let minDeltaPp: number | null = null;
  for (const half of halfBuckets) {
    if (half.total < SUMMARY_MIN_SAMPLES) {
      continue;
    }
    const otherHalf = otherHalfByDistance.get(half.distanceBp);
    if (otherHalf === undefined || otherHalf.total < SUMMARY_MIN_SAMPLES) {
      continue;
    }
    const base = baselineByDistance.get(half.distanceBp);
    if (base === undefined) {
      continue;
    }
    const halfRate = half.survived / half.total;
    const baseRate = base.survived / base.total;
    const deltaPp = (halfRate - baseRate) * 100;
    if (maxDeltaPp === null || deltaPp > maxDeltaPp) {
      maxDeltaPp = deltaPp;
    }
    if (minDeltaPp === null || deltaPp < minDeltaPp) {
      minDeltaPp = deltaPp;
    }
    // Per-snapshot log-loss for the half's predictions on the half's
    // own outcomes, vs. the baseline's prediction on those same
    // outcomes. Difference = nats per snapshot saved by conditioning.
    const halfP = clampProb(halfRate);
    const baseP = clampProb(baseRate);
    const halfSurvived = half.survived;
    const halfFailed = half.total - half.survived;
    const halfLogLoss =
      -halfSurvived * Math.log(halfP) - halfFailed * Math.log(1 - halfP);
    const baseLogLoss =
      -halfSurvived * Math.log(baseP) - halfFailed * Math.log(1 - baseP);
    const logLossSavedNats = baseLogLoss - halfLogLoss; // bucket-total nats saved
    counted.push({ deltaPp, weight: half.total, logLossSavedNats });
  }
  const coverageBp = counted.length;
  if (coverageBp === 0) {
    return {
      score: 0,
      coverageBp: 0,
      meanDeltaPp: null,
      maxDeltaPp: null,
      minDeltaPp: null,
      sharpe: null,
      logLossImprovementNats: null,
    };
  }
  let weightedDeltaSum = 0;
  let weightSum = 0;
  let totalLogLossSavedNats = 0;
  let totalSnapshots = 0;
  for (const { deltaPp, weight, logLossSavedNats } of counted) {
    weightedDeltaSum += deltaPp * weight;
    weightSum += weight;
    totalLogLossSavedNats += logLossSavedNats;
    totalSnapshots += weight;
  }
  const weightedMeanDelta = weightSum === 0 ? 0 : weightedDeltaSum / weightSum;
  const score = weightedMeanDelta * coverageBp;
  // Weighted stdev of per-bucket deltas around the weighted mean.
  // `null` when coverageBp < 2 (a single bucket has no spread).
  let sharpe: number | null = null;
  if (coverageBp >= 2 && weightSum > 0) {
    let weightedSqDiffSum = 0;
    for (const { deltaPp, weight } of counted) {
      const diff = deltaPp - weightedMeanDelta;
      weightedSqDiffSum += diff * diff * weight;
    }
    const variance = weightedSqDiffSum / weightSum;
    const stdev = Math.sqrt(variance);
    sharpe = stdev === 0 ? null : weightedMeanDelta / stdev;
  }
  const logLossImprovementNats =
    totalSnapshots === 0 ? null : totalLogLossSavedNats / totalSnapshots;
  return {
    score,
    coverageBp,
    meanDeltaPp: weightedMeanDelta,
    maxDeltaPp,
    minDeltaPp,
    sharpe,
    logLossImprovementNats,
  };
}

function clampProb(p: number): number {
  if (p < PROB_EPSILON) {
    return PROB_EPSILON;
  }
  if (p > 1 - PROB_EPSILON) {
    return 1 - PROB_EPSILON;
  }
  return p;
}
