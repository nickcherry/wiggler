import type { SurvivalRemainingMinutes } from "@alea/lib/training/computeSurvivalSnapshots";
import type {
  SurvivalBucket,
  SurvivalSurface,
} from "@alea/lib/training/types";

/**
 * Threshold for the sweet-spot algorithm: the smallest contiguous bp
 * range that captures this fraction of a filter's total positive info
 * gain becomes the sweet spot. 0.70 picks a tighter range than the
 * conventional Pareto-style 0.80 — i.e. "act only where the bulk of
 * the edge actually lives, dropping the long flat shoulders." The
 * trade-off: lower threshold = narrower range = sharper restricted-
 * range calibration, but lower coverage (more snapshots fall outside
 * the sweet spot and don't get traded on). For our champion
 * `distance_from_line_atr`, 0.70 typically gives ≈50% coverage with
 * meaningfully higher calibration than 0.80's ≈65%.
 *
 * Tunable. See doc/research/2026-05-04-sweet-spot.md for the choice
 * rationale and how the alternatives compare on real data.
 */
export const SWEET_SPOT_INFO_GAIN_THRESHOLD = 0.70;

/**
 * Per-bucket sample-count floor. A bucket is excluded from the sweet-
 * spot computation entirely if either the half being scored OR the
 * global reference at that bucket has fewer than this many samples.
 *
 * Set at 2000: at lower floors (we previously used 300), low-bp
 * buckets in distance-conditioned filters carry a sample-composition
 * artifact whose rates don't generalize. 2000 keeps per-cell binomial
 * SE under ~1pp, comparable to the deltas we measure at trustworthy
 * higher-bp ranges. See doc/research/2026-05-04-sample-floor.md.
 *
 * Lives here (not imported from elsewhere) so consumers of the
 * sweet-spot computation don't need a runtime dependency on the
 * scoring layer.
 */
export const SWEET_SPOT_MIN_SAMPLES = 2000;

const REMAINING_VALUES: readonly SurvivalRemainingMinutes[] = [4, 3, 2, 1];

const PROB_EPSILON = 1e-9;
function clampProb(p: number): number {
  if (p < PROB_EPSILON) {return PROB_EPSILON;}
  if (p > 1 - PROB_EPSILON) {return 1 - PROB_EPSILON;}
  return p;
}

export type SweetSpot = {
  /** Inclusive lower bound of the bp range. */
  readonly startBp: number;
  /** Inclusive upper bound of the bp range. */
  readonly endBp: number;
  /**
   * Restricted-range calibration: average information gain in nats
   * per snapshot **inside the sweet-spot bp range**, vs the global
   * (no-filter) baseline.
   */
  readonly calibrationScore: number;
  /**
   * Fraction of `snapshotsTotal` that falls inside the sweet-spot bp
   * range AND was classified (not skipped). 0..1.
   */
  readonly coverageFraction: number;
};

/**
 * Sweet-spot detection. Aggregates per-bp positive information gain
 * (vs the global baseline) across every counted `(remaining, half,
 * distance)` cell, then picks the **narrowest contiguous bp range**
 * that captures `SWEET_SPOT_INFO_GAIN_THRESHOLD` of the total.
 * Returns `null` when no bp has positive info gain.
 *
 * Same floor (`SWEET_SPOT_MIN_SAMPLES`) as the per-cell scoring —
 * sub-floor buckets contribute zero to the gain map and zero to the
 * sweet-spot snapshot count.
 *
 * Reusable across the training-side scoring (`applySurvivalFilters`)
 * and the trading-side probability-table generation
 * (`computeAssetProbabilities`) so they share a single source of
 * truth for the sweet-spot range live trading restricts to.
 */
export function computeSweetSpot({
  baseline,
  whenTrue,
  whenFalse,
  snapshotsTotal,
}: {
  readonly baseline: SurvivalSurface;
  readonly whenTrue: SurvivalSurface;
  readonly whenFalse: SurvivalSurface;
  readonly snapshotsTotal: number;
}): SweetSpot | null {
  const perBpGain = new Map<number, number>();
  const perBpSnapshots = new Map<number, number>();
  for (const remaining of REMAINING_VALUES) {
    const globalByDistance = new Map<number, SurvivalBucket>();
    for (const b of baseline.byRemaining[remaining]) {
      globalByDistance.set(b.distanceBp, b);
    }
    for (const halfBuckets of [
      whenTrue.byRemaining[remaining],
      whenFalse.byRemaining[remaining],
    ]) {
      for (const half of halfBuckets) {
        if (half.total < SWEET_SPOT_MIN_SAMPLES) {continue;}
        const global = globalByDistance.get(half.distanceBp);
        if (global === undefined || global.total < SWEET_SPOT_MIN_SAMPLES) {
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
        const gain = Math.max(0, globalLogLoss - halfLogLoss);
        perBpGain.set(
          half.distanceBp,
          (perBpGain.get(half.distanceBp) ?? 0) + gain,
        );
        perBpSnapshots.set(
          half.distanceBp,
          (perBpSnapshots.get(half.distanceBp) ?? 0) + half.total,
        );
      }
    }
  }
  if (perBpGain.size === 0) {return null;}
  let totalGain = 0;
  for (const v of perBpGain.values()) {totalGain += v;}
  if (totalGain <= 0) {return null;}
  const bps = [...perBpGain.keys()].sort((a, b) => a - b);
  const target = totalGain * SWEET_SPOT_INFO_GAIN_THRESHOLD;
  // Two-pointer sliding window over the sorted bp list. For each left
  // index `i`, advance `j` until [i..j-1] sums to ≥ target; record the
  // window if it's the narrowest seen so far; then shrink from the
  // left and repeat. Standard "shortest subarray with sum ≥ target"
  // pattern. Range size is measured in bp units (bps[j-1] - bps[i] + 1),
  // not array indices, so a window covering bps {2, 5} is size 4 even
  // though it has only 2 entries — the empty bp 3 and 4 still count.
  let bestStart = -1;
  let bestEnd = -1;
  let bestSize = Number.POSITIVE_INFINITY;
  let runningGain = 0;
  let j = 0;
  for (let i = 0; i < bps.length; i += 1) {
    while (j < bps.length && runningGain < target) {
      const bp = bps[j];
      if (bp === undefined) {break;}
      runningGain += perBpGain.get(bp) ?? 0;
      j += 1;
    }
    if (runningGain >= target) {
      const startBp = bps[i] as number;
      const endBp = bps[j - 1] as number;
      const size = endBp - startBp + 1;
      if (size < bestSize) {
        bestSize = size;
        bestStart = startBp;
        bestEnd = endBp;
      }
    } else {
      // j is at the end and we still couldn't hit target by extending.
      // Shrinking left can't help — no smaller windows possible.
      break;
    }
    runningGain -= perBpGain.get(bps[i] as number) ?? 0;
  }
  if (bestStart === -1 || bestEnd === -1) {return null;}
  let snapshotsInRange = 0;
  let gainInRange = 0;
  for (const [bp, count] of perBpSnapshots) {
    if (bp < bestStart || bp > bestEnd) {continue;}
    snapshotsInRange += count;
    gainInRange += perBpGain.get(bp) ?? 0;
  }
  const calibrationScore =
    snapshotsInRange === 0 ? 0 : gainInRange / snapshotsInRange;
  const coverageFraction =
    snapshotsTotal === 0 ? 0 : snapshotsInRange / snapshotsTotal;
  return {
    startBp: bestStart,
    endBp: bestEnd,
    calibrationScore,
    coverageFraction,
  };
}
