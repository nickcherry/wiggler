import type {
  SurvivalSide,
  SurvivalSnapshot,
  SurvivalSnapshotContext,
} from "@alea/lib/training/computeSurvivalSnapshots";
import { last3x1mMajorityAlignmentFilter } from "@alea/lib/training/survivalFilters/last3x1mMajorityAlignment";
import { ma205mAlignmentFilter } from "@alea/lib/training/survivalFilters/ma205mAlignment";
import { prev1mDirectionAlignmentFilter } from "@alea/lib/training/survivalFilters/prev1mDirectionAlignment";
import { prev5mDirectionAlignmentFilter } from "@alea/lib/training/survivalFilters/prev5mDirectionAlignment";
import { describe, expect, it } from "bun:test";

function emptyContext(): SurvivalSnapshotContext {
  return {
    prev1mDirection: null,
    prev5mDirection: null,
    prev5mClose: null,
    last3x1mDirections: null,
    ma20x5m: null,
  };
}

function buildSnapshot({
  currentSide,
  line = 100,
  context,
}: {
  readonly currentSide: SurvivalSide;
  readonly line?: number;
  readonly context: SurvivalSnapshotContext;
}): SurvivalSnapshot {
  return {
    windowStartMs: 0,
    year: "2025",
    line,
    finalPrice: line,
    finalSide: currentSide,
    snapshotPrice: line,
    currentSide,
    distanceBp: 0,
    remaining: 1,
    survived: true,
    context,
  };
}

describe("prev1mDirectionAlignmentFilter", () => {
  it("returns true when previous 1m matches current side", () => {
    const snap = buildSnapshot({
      currentSide: "up",
      context: { ...emptyContext(), prev1mDirection: "up" },
    });
    expect(prev1mDirectionAlignmentFilter.classify(snap, snap.context)).toBe(
      true,
    );
  });

  it("returns false when previous 1m disagrees with current side", () => {
    const snap = buildSnapshot({
      currentSide: "up",
      context: { ...emptyContext(), prev1mDirection: "down" },
    });
    expect(prev1mDirectionAlignmentFilter.classify(snap, snap.context)).toBe(
      false,
    );
  });

  it("returns 'skip' when no prev1m context", () => {
    const snap = buildSnapshot({
      currentSide: "up",
      context: emptyContext(),
    });
    expect(prev1mDirectionAlignmentFilter.classify(snap, snap.context)).toBe(
      "skip",
    );
  });
});

describe("prev5mDirectionAlignmentFilter", () => {
  it("matches current side when prev5m direction matches", () => {
    const snap = buildSnapshot({
      currentSide: "down",
      context: { ...emptyContext(), prev5mDirection: "down" },
    });
    expect(prev5mDirectionAlignmentFilter.classify(snap, snap.context)).toBe(
      true,
    );
  });

  it("skips when prev5m unavailable", () => {
    const snap = buildSnapshot({
      currentSide: "up",
      context: emptyContext(),
    });
    expect(prev5mDirectionAlignmentFilter.classify(snap, snap.context)).toBe(
      "skip",
    );
  });
});

describe("ma205mAlignmentFilter", () => {
  it("aligns UP when line >= MA", () => {
    const snap = buildSnapshot({
      currentSide: "up",
      line: 105,
      context: { ...emptyContext(), ma20x5m: 100 },
    });
    expect(ma205mAlignmentFilter.classify(snap, snap.context)).toBe(true);
  });

  it("DOWN against bullish regime is not aligned", () => {
    const snap = buildSnapshot({
      currentSide: "down",
      line: 105,
      context: { ...emptyContext(), ma20x5m: 100 },
    });
    expect(ma205mAlignmentFilter.classify(snap, snap.context)).toBe(false);
  });

  it("aligns DOWN when line < MA", () => {
    const snap = buildSnapshot({
      currentSide: "down",
      line: 95,
      context: { ...emptyContext(), ma20x5m: 100 },
    });
    expect(ma205mAlignmentFilter.classify(snap, snap.context)).toBe(true);
  });

  it("skips when MA unavailable", () => {
    const snap = buildSnapshot({
      currentSide: "up",
      context: emptyContext(),
    });
    expect(ma205mAlignmentFilter.classify(snap, snap.context)).toBe("skip");
  });
});

describe("last3x1mMajorityAlignmentFilter", () => {
  it("aligns when majority direction matches current side", () => {
    const snap = buildSnapshot({
      currentSide: "up",
      context: {
        ...emptyContext(),
        last3x1mDirections: ["up", "up", "down"],
      },
    });
    expect(last3x1mMajorityAlignmentFilter.classify(snap, snap.context)).toBe(
      true,
    );
  });

  it("does not align when majority is opposite", () => {
    const snap = buildSnapshot({
      currentSide: "up",
      context: {
        ...emptyContext(),
        last3x1mDirections: ["down", "down", "up"],
      },
    });
    expect(last3x1mMajorityAlignmentFilter.classify(snap, snap.context)).toBe(
      false,
    );
  });

  it("aligns when all three agree with current side", () => {
    const snap = buildSnapshot({
      currentSide: "down",
      context: {
        ...emptyContext(),
        last3x1mDirections: ["down", "down", "down"],
      },
    });
    expect(last3x1mMajorityAlignmentFilter.classify(snap, snap.context)).toBe(
      true,
    );
  });

  it("skips when fewer than three preceding candles available", () => {
    const snap = buildSnapshot({
      currentSide: "up",
      context: emptyContext(),
    });
    expect(last3x1mMajorityAlignmentFilter.classify(snap, snap.context)).toBe(
      "skip",
    );
  });
});
