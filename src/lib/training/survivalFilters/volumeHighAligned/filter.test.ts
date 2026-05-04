import type {
  SurvivalSide,
  SurvivalSnapshot,
  SurvivalSnapshotContext,
} from "@alea/lib/training/computeSurvivalSnapshots";
import { volumeHighAlignedFilter } from "@alea/lib/training/survivalFilters/volumeHighAligned/filter";
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

describe("volumeHighAlignedFilter", () => {
  it("true when volume ≥ 1.5x avg AND bar direction matches side", () => {
    const snap = buildSnapshot("up", {
      ...emptyContext(),
      prev5mBarVolume: 200,
      avgVolume50x5m: 100,
      prev5mBar: { open: 100, high: 102, low: 99, close: 101 }, // up bar
    });
    expect(volumeHighAlignedFilter.classify(snap, snap.context)).toBe(true);
  });

  it("false when volume high but bar direction opposes side", () => {
    const snap = buildSnapshot("up", {
      ...emptyContext(),
      prev5mBarVolume: 200,
      avgVolume50x5m: 100,
      prev5mBar: { open: 102, high: 102, low: 99, close: 100 }, // down bar
    });
    expect(volumeHighAlignedFilter.classify(snap, snap.context)).toBe(false);
  });

  it("false when volume below threshold", () => {
    const snap = buildSnapshot("up", {
      ...emptyContext(),
      prev5mBarVolume: 110,
      avgVolume50x5m: 100,
      prev5mBar: { open: 100, high: 102, low: 99, close: 101 },
    });
    expect(volumeHighAlignedFilter.classify(snap, snap.context)).toBe(false);
  });

  it("skips when volume context unavailable", () => {
    const snap = buildSnapshot("up", emptyContext());
    expect(volumeHighAlignedFilter.classify(snap, snap.context)).toBe("skip");
  });
});
