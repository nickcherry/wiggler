import type {
  SurvivalSide,
  SurvivalSnapshot,
  SurvivalSnapshotContext,
} from "@alea/lib/training/computeSurvivalSnapshots";
import { roc5StrongAlignedFilter } from "@alea/lib/training/survivalFilters/roc5StrongAligned/filter";
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

describe("roc5StrongAlignedFilter", () => {
  it("strong positive ROC + UP side = aligned", () => {
    const snap = buildSnapshot("up", { ...emptyContext(), roc5Pct: 0.5 });
    expect(roc5StrongAlignedFilter.classify(snap, snap.context)).toBe(true);
  });

  it("strong negative ROC + UP side = against", () => {
    const snap = buildSnapshot("up", { ...emptyContext(), roc5Pct: -0.5 });
    expect(roc5StrongAlignedFilter.classify(snap, snap.context)).toBe(false);
  });

  it("skips when |ROC| < threshold", () => {
    const snap = buildSnapshot("up", { ...emptyContext(), roc5Pct: 0.1 });
    expect(roc5StrongAlignedFilter.classify(snap, snap.context)).toBe("skip");
  });

  it("skips when ROC unavailable", () => {
    const snap = buildSnapshot("up", emptyContext());
    expect(roc5StrongAlignedFilter.classify(snap, snap.context)).toBe("skip");
  });
});
