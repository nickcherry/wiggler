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
    prev5mDirection: null,
    prev5mClose: null,
    last3x5mDirections: null,
    ma20x5m: null,
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
        // Encode decision in context so a probe filter can recover it.
        context: {
          ...emptyContext(),
          // We tag with `prev5mDirection` since the existing field type
          // accepts it; the probe filter reads this.
          prev5mDirection:
            decision === true ? "up" : decision === false ? "down" : null,
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
          prev5mDirection: "down",
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
    if (context.prev5mDirection === null) {
      return "skip";
    }
    return context.prev5mDirection === "up";
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
          context: { ...emptyContext(), prev5mDirection: "up" },
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
          context: { ...emptyContext(), prev5mDirection: "down" },
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
              prev5mDirection: side === "true" ? "up" : "down",
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
  });
});
