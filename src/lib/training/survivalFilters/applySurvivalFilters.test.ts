import type {
  SurvivalSide,
  SurvivalSnapshot,
  SurvivalSnapshotContext,
} from "@alea/lib/training/computeSurvivalSnapshots";
import { applySurvivalFilters } from "@alea/lib/training/survivalFilters/applySurvivalFilters";
import type {
  SurvivalFilter,
  SurvivalFilterDecision,
} from "@alea/lib/training/survivalFilters/types";
import { describe, expect, it } from "bun:test";

function emptyContext(): SurvivalSnapshotContext {
  return {
    last3x5mDirections: null,
    last5x5mDirections: null,
    ma20x5m: null,
    ma50x5m: null,
    ema20x5m: null,
    ema50x5m: null,
    ema50SlopePct: null,
    rsi14x5m: null,
    roc20Pct: null,
    atr14x5m: null,
    atr50x5m: null,
    donchian50High: null,
    donchian50Low: null,
    prev5mBar: null,
    prevPrev5mBar: null,
    bbStddev20x5m: null,
    last10x5mDirections: null,
    roc5Pct: null,
    stoch14x5m: null,
    prev5mBarVolume: null,
    avgVolume50x5m: null,
    avgRangeRecent5x5m: null,
    avgRangePrior5x5m: null,
    bars5mSinceDonchian50High: null,
    bars5mSinceDonchian50Low: null,
    currentMicroBarDirection: "up",
    prevMicroDistanceBp: null,
  };
}

function buildSnapshot({
  windowStartMs,
  remaining,
  distanceBp,
  survived,
  currentSide = "up",
  context = emptyContext(),
}: {
  readonly windowStartMs: number;
  readonly remaining: 1 | 2 | 3 | 4;
  readonly distanceBp: number;
  readonly survived: boolean;
  readonly currentSide?: SurvivalSide;
  readonly context?: SurvivalSnapshotContext;
}): SurvivalSnapshot {
  return {
    windowStartMs,
    year: "2025",
    line: 100,
    finalPrice: 100,
    finalSide: "up",
    snapshotPrice: 100,
    currentSide,
    distanceBp,
    remaining,
    survived,
    context,
  };
}

const SAMPLE_FLOOR = 500;

function buildBalancedSnapshots({
  remaining,
  distanceBp,
  trueClassifier,
  totalEach,
  trueWinRate,
  falseWinRate,
}: {
  readonly remaining: 1 | 2 | 3 | 4;
  readonly distanceBp: number;
  readonly trueClassifier: (i: number) => SurvivalFilterDecision;
  readonly totalEach: number;
  readonly trueWinRate: number; // 0..1
  readonly falseWinRate: number; // 0..1
}): SurvivalSnapshot[] {
  // Builds `2 * totalEach` snapshots: half classified true, half false,
  // with the requested per-half win rate. Each snapshot gets a unique
  // windowStartMs so windowCount lines up with snapshot count for the
  // assertion math.
  const out: SurvivalSnapshot[] = [];
  const trueWins = Math.round(trueWinRate * totalEach);
  const falseWins = Math.round(falseWinRate * totalEach);
  for (let i = 0; i < totalEach; i += 1) {
    const decision = trueClassifier(i);
    const survived = i < trueWins;
    out.push(
      buildSnapshot({
        windowStartMs: 1_000_000 + i,
        remaining,
        distanceBp,
        survived,
        // Encode the desired classification in `ma20x5m` so the probe
        // filter below can recover it: positive value → true, negative
        // → false, null → skip.
        context: {
          ...emptyContext(),
          ma20x5m:
            decision === true ? 1 : decision === false ? -1 : null,
        },
      }),
    );
  }
  for (let i = 0; i < totalEach; i += 1) {
    const survived = i < falseWins;
    out.push(
      buildSnapshot({
        windowStartMs: 2_000_000 + i,
        remaining,
        distanceBp,
        survived,
        context: {
          ...emptyContext(),
          ma20x5m: -1,
        },
      }),
    );
  }
  return out;
}

const probeFilter: SurvivalFilter = {
  id: "probe",
  displayName: "Probe",
  description: "Test filter",
  trueLabel: "T",
  falseLabel: "F",
  version: 1,
  classify: (snapshot, context) => {
    const v = context.ma20x5m;
    if (v === null) {
      return "skip";
    }
    return v > 0;
  },
};

describe("applySurvivalFilters", () => {
  it("returns one result per filter, with the shared baseline surface", () => {
    const snapshots = buildBalancedSnapshots({
      remaining: 1,
      distanceBp: 5,
      trueClassifier: () => true,
      totalEach: 600,
      trueWinRate: 0.9,
      falseWinRate: 0.5,
    });
    const { baseline, perFilter } = applySurvivalFilters({
      snapshots,
      filters: [probeFilter],
    });
    expect(perFilter.length).toBe(1);
    const result = perFilter[0];
    if (result === undefined) {
      throw new Error("expected result");
    }
    expect(result.baseline).toBe(baseline);
    expect(baseline.windowCount).toBe(1200); // each snapshot has its own windowStartMs
  });

  it("splits snapshots into when-true and when-false buckets, ignoring skipped", () => {
    const snapshots: SurvivalSnapshot[] = [];
    for (let i = 0; i < 600; i += 1) {
      snapshots.push(
        buildSnapshot({
          windowStartMs: 1_000_000 + i,
          remaining: 1,
          distanceBp: 5,
          survived: i < 540, // 90%
          context: { ...emptyContext(), ma20x5m: 1 },
        }),
      );
    }
    for (let i = 0; i < 600; i += 1) {
      snapshots.push(
        buildSnapshot({
          windowStartMs: 2_000_000 + i,
          remaining: 1,
          distanceBp: 5,
          survived: i < 300, // 50%
          context: { ...emptyContext(), ma20x5m: -1 },
        }),
      );
    }
    // Add 50 snapshots the filter skips (no prev1m direction).
    for (let i = 0; i < 50; i += 1) {
      snapshots.push(
        buildSnapshot({
          windowStartMs: 3_000_000 + i,
          remaining: 1,
          distanceBp: 5,
          survived: true,
        }),
      );
    }

    const { perFilter } = applySurvivalFilters({
      snapshots,
      filters: [probeFilter],
    });
    const result = perFilter[0];
    if (result === undefined) {
      throw new Error("expected result");
    }
    expect(result.summary.snapshotsTrue).toBe(600);
    expect(result.summary.snapshotsFalse).toBe(600);
    expect(result.summary.snapshotsSkipped).toBe(50);
    expect(result.summary.occurrenceTrue).toBeCloseTo(0.5, 6);
    expect(result.summary.occurrenceFalse).toBeCloseTo(0.5, 6);
    // Both halves clear the sample-count floor of 500 → both should
    // produce real win-rate buckets.
    const trueBucket = result.whenTrue.byRemaining[1].find(
      (b) => b.distanceBp === 5,
    );
    const falseBucket = result.whenFalse.byRemaining[1].find(
      (b) => b.distanceBp === 5,
    );
    expect(trueBucket?.total).toBe(600);
    expect(trueBucket?.survived).toBe(540);
    expect(falseBucket?.total).toBe(600);
    expect(falseBucket?.survived).toBe(300);
  });

  it("scores each (remaining, half) as the signed area of pp deltas vs baseline", () => {
    // Construct a scenario at 1m left where the true half consistently
    // outperforms baseline and the false half consistently underperforms.
    // At 3 distinct bp buckets {2, 5, 8}, with samples:
    //   bucket 2: true=60%, false=20% → combined 40%
    //   bucket 5: true=80%, false=40% → combined 60%
    //   bucket 8: true=95%, false=60% → combined 77.5%
    // → baseline pp at each bucket: 40, 60, 77.5
    // → true delta vs baseline: +20, +20, +17.5 → score = +57.5
    // → false delta vs baseline: -20, -20, -17.5 → score = -57.5
    const snapshots: SurvivalSnapshot[] = [];
    const push = (
      distanceBp: number,
      side: "true" | "false",
      survivedCount: number,
      total: number,
    ) => {
      for (let i = 0; i < total; i += 1) {
        snapshots.push(
          buildSnapshot({
            windowStartMs:
              distanceBp * 1_000_000 + (side === "true" ? 1 : 2) * 100_000 + i,
            remaining: 1,
            distanceBp,
            survived: i < survivedCount,
            context: {
              ...emptyContext(),
              ma20x5m: side === "true" ? 1 : -1,
            },
          }),
        );
      }
    };
    push(2, "true", Math.round(0.6 * SAMPLE_FLOOR), SAMPLE_FLOOR);
    push(2, "false", Math.round(0.2 * SAMPLE_FLOOR), SAMPLE_FLOOR);
    push(5, "true", Math.round(0.8 * SAMPLE_FLOOR), SAMPLE_FLOOR);
    push(5, "false", Math.round(0.4 * SAMPLE_FLOOR), SAMPLE_FLOOR);
    push(8, "true", Math.round(0.95 * SAMPLE_FLOOR), SAMPLE_FLOOR);
    push(8, "false", Math.round(0.6 * SAMPLE_FLOOR), SAMPLE_FLOOR);

    const { perFilter } = applySurvivalFilters({
      snapshots,
      filters: [probeFilter],
    });
    const result = perFilter[0];
    if (result === undefined) {
      throw new Error("expected result");
    }
    const trueScore = result.summary.scoresByRemaining[1].true;
    const falseScore = result.summary.scoresByRemaining[1].false;
    expect(trueScore.coverageBp).toBe(3);
    expect(falseScore.coverageBp).toBe(3);
    expect(trueScore.score).toBeCloseTo(57.5, 5);
    expect(falseScore.score).toBeCloseTo(-57.5, 5);
    // Decorative metrics
    expect(trueScore.maxDeltaPp).toBeCloseTo(20, 5);
    expect(trueScore.minDeltaPp).toBeCloseTo(17.5, 5);
    expect(falseScore.maxDeltaPp).toBeCloseTo(-17.5, 5);
    expect(falseScore.minDeltaPp).toBeCloseTo(-20, 5);
    expect(trueScore.meanDeltaPp).toBeCloseTo(57.5 / 3, 5);
  });

  it("weights bucket deltas by sample size: a dense bucket dominates a sparse one", () => {
    // Two buckets at the same remaining (1m left):
    //   bucket 2: dense, true overperforms baseline by ~+10pp
    //   bucket 8: sparse (just above the sample floor), true overperforms by ~+30pp
    // The unweighted score would be +40 / 2 = +20 mean. With sample
    // weighting, bucket 2 dominates so the mean drops below +20 toward
    // the dense bucket's +10pp.
    const denseTotal = SAMPLE_FLOOR * 30;
    const sparseTotal = SAMPLE_FLOOR; // just above the floor
    const snapshots: SurvivalSnapshot[] = [];
    const push = (
      distanceBp: number,
      side: "true" | "false",
      survivedCount: number,
      total: number,
    ) => {
      for (let i = 0; i < total; i += 1) {
        snapshots.push(
          buildSnapshot({
            windowStartMs:
              distanceBp * 1_000_000 + (side === "true" ? 1 : 2) * 100_000 + i,
            remaining: 1,
            distanceBp,
            survived: i < survivedCount,
            context: {
              ...emptyContext(),
              ma20x5m: side === "true" ? 1 : -1,
            },
          }),
        );
      }
    };
    // bucket 2: combined baseline 50% (true 55%, false 45%) → true delta ≈ +5pp
    push(2, "true", Math.round(0.55 * denseTotal), denseTotal);
    push(2, "false", Math.round(0.45 * denseTotal), denseTotal);
    // bucket 8: combined baseline 50% (true 80%, false 20%) → true delta ≈ +30pp
    push(8, "true", Math.round(0.8 * sparseTotal), sparseTotal);
    push(8, "false", Math.round(0.2 * sparseTotal), sparseTotal);

    const { perFilter } = applySurvivalFilters({
      snapshots,
      filters: [probeFilter],
    });
    const score = perFilter[0]?.summary.scoresByRemaining[1].true;
    if (score === undefined) {throw new Error("expected score");}
    expect(score.coverageBp).toBe(2);
    // Mean delta should be heavily pulled toward the dense bucket's +5pp,
    // not the unweighted midpoint of (5 + 30) / 2 = 17.5.
    expect(score.meanDeltaPp).not.toBeNull();
    expect(score.meanDeltaPp).toBeLessThan(10);
    // Decorative max stays unweighted: still +30pp (the sparse bucket
    // is the highest single-bucket delta).
    expect(score.maxDeltaPp).toBeGreaterThanOrEqual(29);
  });

  it("returns zero-coverage scores when nothing clears the sample floor", () => {
    const snapshots = buildBalancedSnapshots({
      remaining: 1,
      distanceBp: 5,
      trueClassifier: () => true,
      totalEach: 50, // below SAMPLE_FLOOR
      trueWinRate: 0.7,
      falseWinRate: 0.5,
    });
    const { perFilter } = applySurvivalFilters({
      snapshots,
      filters: [probeFilter],
    });
    const trueScore = perFilter[0]?.summary.scoresByRemaining[1].true;
    expect(trueScore?.coverageBp).toBe(0);
    expect(trueScore?.score).toBe(0);
    expect(trueScore?.meanDeltaPp).toBeNull();
    expect(trueScore?.sharpe).toBeNull();
    expect(trueScore?.logLossImprovementNats).toBeNull();
  });

  it("populates sharpe and log-loss improvement with correct signs and edge cases", () => {
    // Same scenario as the signed-area test: three buckets where true
    // overperforms by ~+20pp consistently. Per-bucket deltas are tight
    // (+20, +20, +17.5) so sharpe should be high; log-loss should
    // improve (positive nats saved) for the better half and the worse
    // half should show a loss (negative).
    const snapshots: SurvivalSnapshot[] = [];
    const push = (
      distanceBp: number,
      side: "true" | "false",
      survivedCount: number,
      total: number,
    ) => {
      for (let i = 0; i < total; i += 1) {
        snapshots.push(
          buildSnapshot({
            windowStartMs:
              distanceBp * 1_000_000 + (side === "true" ? 1 : 2) * 100_000 + i,
            remaining: 1,
            distanceBp,
            survived: i < survivedCount,
            context: {
              ...emptyContext(),
              ma20x5m: side === "true" ? 1 : -1,
            },
          }),
        );
      }
    };
    push(2, "true", Math.round(0.6 * SAMPLE_FLOOR), SAMPLE_FLOOR);
    push(2, "false", Math.round(0.2 * SAMPLE_FLOOR), SAMPLE_FLOOR);
    push(5, "true", Math.round(0.8 * SAMPLE_FLOOR), SAMPLE_FLOOR);
    push(5, "false", Math.round(0.4 * SAMPLE_FLOOR), SAMPLE_FLOOR);
    push(8, "true", Math.round(0.95 * SAMPLE_FLOOR), SAMPLE_FLOOR);
    push(8, "false", Math.round(0.6 * SAMPLE_FLOOR), SAMPLE_FLOOR);

    const { perFilter } = applySurvivalFilters({
      snapshots,
      filters: [probeFilter],
    });
    const trueScore = perFilter[0]?.summary.scoresByRemaining[1].true;
    const falseScore = perFilter[0]?.summary.scoresByRemaining[1].false;
    if (trueScore === undefined || falseScore === undefined) {
      throw new Error("expected scores");
    }
    // Both halves at a given (remaining) are sign-opposed under the
    // conditioned-baseline scoring.
    expect(trueScore.score).toBeGreaterThan(0);
    expect(falseScore.score).toBeLessThan(0);
    // Sharpe matches mean's sign; magnitude should be high since the
    // three per-bucket deltas (+20, +20, +17.5) are tightly clustered.
    expect(trueScore.sharpe).not.toBeNull();
    expect(trueScore.sharpe! > 5).toBe(true);
    expect(falseScore.sharpe).not.toBeNull();
    expect(falseScore.sharpe! < -5).toBe(true);
    // Better-performing half saves nats; worse half pays nats.
    expect(trueScore.logLossImprovementNats).not.toBeNull();
    expect(trueScore.logLossImprovementNats! > 0).toBe(true);
    expect(falseScore.logLossImprovementNats).not.toBeNull();
    expect(falseScore.logLossImprovementNats! > 0).toBe(true);
    // Both halves' log-loss-improvement is positive: each half's own
    // win-rate is a better predictor of its own outcomes than the
    // conditioned baseline (the average of the two). That's the
    // information-gain interpretation — it's about predicting the
    // half's outcomes, not winning vs. the other side.
  });

  it("returns null sharpe when only one bucket is comparable", () => {
    const snapshots = buildBalancedSnapshots({
      remaining: 1,
      distanceBp: 5,
      trueClassifier: () => true,
      totalEach: SAMPLE_FLOOR,
      trueWinRate: 0.7,
      falseWinRate: 0.4,
    });
    const { perFilter } = applySurvivalFilters({
      snapshots,
      filters: [probeFilter],
    });
    const trueScore = perFilter[0]?.summary.scoresByRemaining[1].true;
    expect(trueScore?.coverageBp).toBe(1);
    expect(trueScore?.sharpe).toBeNull();
    // Log-loss improvement still defined even with one bucket.
    expect(trueScore?.logLossImprovementNats).not.toBeNull();
  });
});
