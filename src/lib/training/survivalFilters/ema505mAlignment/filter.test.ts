import type {
  SurvivalSide,
  SurvivalSnapshot,
  SurvivalSnapshotContext,
} from "@alea/lib/training/computeSurvivalSnapshots";
import { ema505mAlignmentFilter } from "@alea/lib/training/survivalFilters/ema505mAlignment/filter";
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
    atr3x5m: null,
    atr4x5m: null,
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

describe("ema505mAlignmentFilter", () => {
  it("aligns UP when line >= EMA", () => {
    const snap = buildSnapshot({
      currentSide: "up",
      line: 105,
      context: { ...emptyContext(), ema50x5m: 100 },
    });
    expect(ema505mAlignmentFilter.classify(snap, snap.context)).toBe(true);
  });

  it("DOWN against a bullish EMA regime is not aligned", () => {
    const snap = buildSnapshot({
      currentSide: "down",
      line: 105,
      context: { ...emptyContext(), ema50x5m: 100 },
    });
    expect(ema505mAlignmentFilter.classify(snap, snap.context)).toBe(false);
  });

  it("aligns DOWN when line < EMA", () => {
    const snap = buildSnapshot({
      currentSide: "down",
      line: 95,
      context: { ...emptyContext(), ema50x5m: 100 },
    });
    expect(ema505mAlignmentFilter.classify(snap, snap.context)).toBe(true);
  });

  it("skips when EMA unavailable", () => {
    const snap = buildSnapshot({
      currentSide: "up",
      context: emptyContext(),
    });
    expect(ema505mAlignmentFilter.classify(snap, snap.context)).toBe("skip");
  });
});
