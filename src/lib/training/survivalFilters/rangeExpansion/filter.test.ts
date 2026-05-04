import type {
  SurvivalSide,
  SurvivalSnapshot,
  SurvivalSnapshotContext,
} from "@alea/lib/training/computeSurvivalSnapshots";
import { rangeExpansionFilter } from "@alea/lib/training/survivalFilters/rangeExpansion/filter";
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

describe("rangeExpansionFilter", () => {
  it("true when last bar's range ≥ 1.5× ATR", () => {
    // range 15, atr 5 → ratio 3 → true
    const snap = buildSnapshot("up", {
      ...emptyContext(),
      atr14x5m: 5,
      prev5mBar: { open: 100, high: 110, low: 95, close: 108 },
    });
    expect(rangeExpansionFilter.classify(snap, snap.context)).toBe(true);
  });

  it("false when range smaller than 1.5× ATR", () => {
    // range 4, atr 5 → ratio 0.8 → false
    const snap = buildSnapshot("up", {
      ...emptyContext(),
      atr14x5m: 5,
      prev5mBar: { open: 100, high: 102, low: 98, close: 101 },
    });
    expect(rangeExpansionFilter.classify(snap, snap.context)).toBe(false);
  });

  it("skips when bar or ATR unavailable", () => {
    const snap = buildSnapshot("up", emptyContext());
    expect(rangeExpansionFilter.classify(snap, snap.context)).toBe("skip");
  });
});
