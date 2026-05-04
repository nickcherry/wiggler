import type {
  SurvivalSide,
  SurvivalSnapshot,
  SurvivalSnapshotContext,
} from "@alea/lib/training/computeSurvivalSnapshots";
import { recentBreakoutAlignedFilter } from "@alea/lib/training/survivalFilters/recentBreakoutAligned/filter";
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

function buildSnapshot(currentSide: SurvivalSide, ctx: SurvivalSnapshotContext): SurvivalSnapshot {
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
    context: ctx,
  };
}

describe("recentBreakoutAlignedFilter", () => {
  it("recent high + UP side = true", () => {
    const snap = buildSnapshot("up", {
      ...emptyContext(),
      bars5mSinceDonchian50High: 2,
      bars5mSinceDonchian50Low: 30,
    });
    expect(recentBreakoutAlignedFilter.classify(snap, snap.context)).toBe(true);
  });

  it("recent high + DOWN side = false", () => {
    const snap = buildSnapshot("down", {
      ...emptyContext(),
      bars5mSinceDonchian50High: 2,
      bars5mSinceDonchian50Low: 30,
    });
    expect(recentBreakoutAlignedFilter.classify(snap, snap.context)).toBe(false);
  });

  it("recent low + DOWN side = true", () => {
    const snap = buildSnapshot("down", {
      ...emptyContext(),
      bars5mSinceDonchian50High: 30,
      bars5mSinceDonchian50Low: 1,
    });
    expect(recentBreakoutAlignedFilter.classify(snap, snap.context)).toBe(true);
  });

  it("skips when neither recent", () => {
    const snap = buildSnapshot("up", {
      ...emptyContext(),
      bars5mSinceDonchian50High: 30,
      bars5mSinceDonchian50Low: 30,
    });
    expect(recentBreakoutAlignedFilter.classify(snap, snap.context)).toBe("skip");
  });

  it("skips when both recent (degenerate)", () => {
    const snap = buildSnapshot("up", {
      ...emptyContext(),
      bars5mSinceDonchian50High: 1,
      bars5mSinceDonchian50Low: 2,
    });
    expect(recentBreakoutAlignedFilter.classify(snap, snap.context)).toBe("skip");
  });
});
