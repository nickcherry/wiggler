import type {
  SurvivalSide,
  SurvivalSnapshot,
  SurvivalSnapshotContext,
} from "@alea/lib/training/computeSurvivalSnapshots";
import { bullishBodyAlignmentFilter } from "@alea/lib/training/survivalFilters/bullishBodyAlignment/filter";
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

describe("bullishBodyAlignmentFilter", () => {
  it("decisive up bar + UP side = aligned", () => {
    // body 8, range 10 → bodyRatio 0.8 ≥ 0.6
    const snap = buildSnapshot("up", {
      ...emptyContext(),
      prev5mBar: { open: 100, high: 110, low: 100, close: 108 },
    });
    expect(bullishBodyAlignmentFilter.classify(snap, snap.context)).toBe(true);
  });

  it("decisive down bar + UP side = against", () => {
    const snap = buildSnapshot("up", {
      ...emptyContext(),
      prev5mBar: { open: 100, high: 100, low: 90, close: 92 },
    });
    expect(bullishBodyAlignmentFilter.classify(snap, snap.context)).toBe(false);
  });

  it("skips when bar body too small (long-wick rejection)", () => {
    // body 1, range 10 → 0.1 < 0.6
    const snap = buildSnapshot("up", {
      ...emptyContext(),
      prev5mBar: { open: 100, high: 105, low: 95, close: 101 },
    });
    expect(bullishBodyAlignmentFilter.classify(snap, snap.context)).toBe("skip");
  });

  it("skips when no bar context", () => {
    const snap = buildSnapshot("up", emptyContext());
    expect(bullishBodyAlignmentFilter.classify(snap, snap.context)).toBe("skip");
  });
});
