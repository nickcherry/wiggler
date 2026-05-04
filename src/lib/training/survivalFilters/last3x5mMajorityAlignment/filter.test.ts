import type {
  SurvivalSide,
  SurvivalSnapshot,
  SurvivalSnapshotContext,
} from "@alea/lib/training/computeSurvivalSnapshots";
import { last3x5mMajorityAlignmentFilter } from "@alea/lib/training/survivalFilters/last3x5mMajorityAlignment/filter";
import { describe, expect, it } from "bun:test";

function emptyContext(): SurvivalSnapshotContext {
  return {
    last3x5mDirections: null,
    last5x5mDirections: null,
    ma20x5m: null,
    ma50x5m: null,
    ema20x5m: null,
    ema50x5m: null,
  };
}

function buildSnapshot({
  currentSide,
  context,
}: {
  readonly currentSide: SurvivalSide;
  readonly context: SurvivalSnapshotContext;
}): SurvivalSnapshot {
  return {
    windowStartMs: 0,
    year: "2025",
    line: 100,
    finalPrice: 100,
    finalSide: currentSide,
    snapshotPrice: 100,
    currentSide,
    distanceBp: 0,
    remaining: 1,
    survived: true,
    context,
  };
}

describe("last3x5mMajorityAlignmentFilter", () => {
  it("aligns when majority direction matches current side", () => {
    const snap = buildSnapshot({
      currentSide: "up",
      context: {
        ...emptyContext(),
        last3x5mDirections: ["up", "up", "down"],
      },
    });
    expect(last3x5mMajorityAlignmentFilter.classify(snap, snap.context)).toBe(
      true,
    );
  });

  it("does not align when majority is opposite", () => {
    const snap = buildSnapshot({
      currentSide: "up",
      context: {
        ...emptyContext(),
        last3x5mDirections: ["down", "down", "up"],
      },
    });
    expect(last3x5mMajorityAlignmentFilter.classify(snap, snap.context)).toBe(
      false,
    );
  });

  it("aligns when all three agree with current side", () => {
    const snap = buildSnapshot({
      currentSide: "down",
      context: {
        ...emptyContext(),
        last3x5mDirections: ["down", "down", "down"],
      },
    });
    expect(last3x5mMajorityAlignmentFilter.classify(snap, snap.context)).toBe(
      true,
    );
  });

  it("skips when fewer than three preceding 5m bars are available", () => {
    const snap = buildSnapshot({
      currentSide: "up",
      context: emptyContext(),
    });
    expect(last3x5mMajorityAlignmentFilter.classify(snap, snap.context)).toBe(
      "skip",
    );
  });
});
