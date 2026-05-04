import type {
  SurvivalSide,
  SurvivalSnapshot,
  SurvivalSnapshotContext,
} from "@alea/lib/training/computeSurvivalSnapshots";
import { stochasticExtremeAgainstFilter } from "@alea/lib/training/survivalFilters/stochasticExtremeAgainst/filter";
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

describe("stochasticExtremeAgainstFilter", () => {
  it("Stoch ≥ 80 + DOWN side = fading", () => {
    const snap = buildSnapshot("down", { ...emptyContext(), stoch14x5m: 90 });
    expect(stochasticExtremeAgainstFilter.classify(snap, snap.context)).toBe(true);
  });

  it("Stoch ≥ 80 + UP side = with extreme", () => {
    const snap = buildSnapshot("up", { ...emptyContext(), stoch14x5m: 90 });
    expect(stochasticExtremeAgainstFilter.classify(snap, snap.context)).toBe(false);
  });

  it("Stoch ≤ 20 + UP side = fading", () => {
    const snap = buildSnapshot("up", { ...emptyContext(), stoch14x5m: 15 });
    expect(stochasticExtremeAgainstFilter.classify(snap, snap.context)).toBe(true);
  });

  it("skips in mid-range", () => {
    const snap = buildSnapshot("up", { ...emptyContext(), stoch14x5m: 50 });
    expect(stochasticExtremeAgainstFilter.classify(snap, snap.context)).toBe("skip");
  });

  it("skips when stochastic unavailable", () => {
    const snap = buildSnapshot("up", emptyContext());
    expect(stochasticExtremeAgainstFilter.classify(snap, snap.context)).toBe("skip");
  });
});
