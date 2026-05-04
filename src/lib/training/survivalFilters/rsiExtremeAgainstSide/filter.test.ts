import type {
  SurvivalSide,
  SurvivalSnapshot,
  SurvivalSnapshotContext,
} from "@alea/lib/training/computeSurvivalSnapshots";
import { rsiExtremeAgainstSideFilter } from "@alea/lib/training/survivalFilters/rsiExtremeAgainstSide/filter";
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

describe("rsiExtremeAgainstSideFilter", () => {
  it("RSI ≥ 70 + DOWN side = fading extreme", () => {
    const snap = buildSnapshot("down", { ...emptyContext(), rsi14x5m: 75 });
    expect(rsiExtremeAgainstSideFilter.classify(snap, snap.context)).toBe(true);
  });

  it("RSI ≥ 70 + UP side = with extreme", () => {
    const snap = buildSnapshot("up", { ...emptyContext(), rsi14x5m: 75 });
    expect(rsiExtremeAgainstSideFilter.classify(snap, snap.context)).toBe(false);
  });

  it("RSI ≤ 30 + UP side = fading extreme", () => {
    const snap = buildSnapshot("up", { ...emptyContext(), rsi14x5m: 25 });
    expect(rsiExtremeAgainstSideFilter.classify(snap, snap.context)).toBe(true);
  });

  it("skips when RSI is mid-range", () => {
    const snap = buildSnapshot("up", { ...emptyContext(), rsi14x5m: 55 });
    expect(rsiExtremeAgainstSideFilter.classify(snap, snap.context)).toBe("skip");
  });

  it("skips when RSI unavailable", () => {
    const snap = buildSnapshot("up", emptyContext());
    expect(rsiExtremeAgainstSideFilter.classify(snap, snap.context)).toBe("skip");
  });
});
