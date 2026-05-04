import type {
  SurvivalSide,
  SurvivalSnapshot,
  SurvivalSnapshotContext,
} from "@alea/lib/training/computeSurvivalSnapshots";
import { ema20AboveEma50AlignmentFilter } from "@alea/lib/training/survivalFilters/ema20AboveEma50Alignment/filter";
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

describe("ema20AboveEma50AlignmentFilter", () => {
  it("aligns UP when EMA20 ≥ EMA50", () => {
    const snap = buildSnapshot("up", { ...emptyContext(), ema20x5m: 105, ema50x5m: 100 });
    expect(ema20AboveEma50AlignmentFilter.classify(snap, snap.context)).toBe(true);
  });

  it("aligns DOWN when EMA20 < EMA50", () => {
    const snap = buildSnapshot("down", { ...emptyContext(), ema20x5m: 95, ema50x5m: 100 });
    expect(ema20AboveEma50AlignmentFilter.classify(snap, snap.context)).toBe(true);
  });

  it("returns false when side disagrees with the cross", () => {
    const snap = buildSnapshot("up", { ...emptyContext(), ema20x5m: 95, ema50x5m: 100 });
    expect(ema20AboveEma50AlignmentFilter.classify(snap, snap.context)).toBe(false);
  });

  it("skips when either EMA is unavailable", () => {
    const snap = buildSnapshot("up", { ...emptyContext(), ema20x5m: 100 });
    expect(ema20AboveEma50AlignmentFilter.classify(snap, snap.context)).toBe("skip");
  });
});
