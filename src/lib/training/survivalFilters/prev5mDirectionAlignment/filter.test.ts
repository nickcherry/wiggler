import type {
  SurvivalSide,
  SurvivalSnapshot,
  SurvivalSnapshotContext,
} from "@alea/lib/training/computeSurvivalSnapshots";
import { prev5mDirectionAlignmentFilter } from "@alea/lib/training/survivalFilters/prev5mDirectionAlignment/filter";
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

  it("returns false when prev5m disagrees", () => {
    const snap = buildSnapshot({
      currentSide: "up",
      context: { ...emptyContext(), prev5mDirection: "down" },
    });
    expect(prev5mDirectionAlignmentFilter.classify(snap, snap.context)).toBe(
      false,
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
