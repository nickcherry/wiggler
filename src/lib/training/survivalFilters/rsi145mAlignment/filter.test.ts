import type {
  SurvivalSide,
  SurvivalSnapshot,
  SurvivalSnapshotContext,
} from "@alea/lib/training/computeSurvivalSnapshots";
import { rsi145mAlignmentFilter } from "@alea/lib/training/survivalFilters/rsi145mAlignment/filter";
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

describe("rsi145mAlignmentFilter", () => {
  it("RSI ≥ 50 aligns with UP side", () => {
    const snap = buildSnapshot("up", { ...emptyContext(), rsi14x5m: 60 });
    expect(rsi145mAlignmentFilter.classify(snap, snap.context)).toBe(true);
  });

  it("RSI < 50 aligns with DOWN side", () => {
    const snap = buildSnapshot("down", { ...emptyContext(), rsi14x5m: 35 });
    expect(rsi145mAlignmentFilter.classify(snap, snap.context)).toBe(true);
  });

  it("RSI = 50 counts as bullish (UP-aligned)", () => {
    const snap = buildSnapshot("up", { ...emptyContext(), rsi14x5m: 50 });
    expect(rsi145mAlignmentFilter.classify(snap, snap.context)).toBe(true);
  });

  it("skips when RSI is null", () => {
    const snap = buildSnapshot("up", emptyContext());
    expect(rsi145mAlignmentFilter.classify(snap, snap.context)).toBe("skip");
  });
});
