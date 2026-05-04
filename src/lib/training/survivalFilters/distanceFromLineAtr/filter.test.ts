import type {
  SurvivalSide,
  SurvivalSnapshot,
  SurvivalSnapshotContext,
} from "@alea/lib/training/computeSurvivalSnapshots";
import { distanceFromLineAtrFilter } from "@alea/lib/training/survivalFilters/distanceFromLineAtr/filter";
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
  currentSide,
  line,
  snapshotPrice,
  ctx,
}: {
  readonly currentSide: SurvivalSide;
  readonly line: number;
  readonly snapshotPrice: number;
  readonly ctx: SurvivalSnapshotContext;
}): SurvivalSnapshot {
  return {
    windowStartMs: 0,
    year: "2025",
    line,
    finalPrice: snapshotPrice,
    finalSide: currentSide,
    snapshotPrice,
    currentSide,
    distanceBp: 0,
    remaining: 1,
    survived: true,
    context: ctx,
  };
}

describe("distanceFromLineAtrFilter", () => {
  it("true when |price - line| ≥ 0.5 × ATR", () => {
    const snap = buildSnapshot({
      currentSide: "up",
      line: 100,
      snapshotPrice: 100.6,
      ctx: { ...emptyContext(), atr14x5m: 1 },
    });
    expect(distanceFromLineAtrFilter.classify(snap, snap.context)).toBe(true);
  });

  it("false when |price - line| < 0.5 × ATR", () => {
    const snap = buildSnapshot({
      currentSide: "up",
      line: 100,
      snapshotPrice: 100.3,
      ctx: { ...emptyContext(), atr14x5m: 1 },
    });
    expect(distanceFromLineAtrFilter.classify(snap, snap.context)).toBe(false);
  });

  it("skips when ATR unavailable", () => {
    const snap = buildSnapshot({
      currentSide: "up",
      line: 100,
      snapshotPrice: 102,
      ctx: emptyContext(),
    });
    expect(distanceFromLineAtrFilter.classify(snap, snap.context)).toBe("skip");
  });
});
