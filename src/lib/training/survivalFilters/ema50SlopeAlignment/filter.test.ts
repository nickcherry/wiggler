import type {
  SurvivalSide,
  SurvivalSnapshot,
  SurvivalSnapshotContext,
} from "@alea/lib/training/computeSurvivalSnapshots";
import { ema50SlopeAlignmentFilter } from "@alea/lib/training/survivalFilters/ema50SlopeAlignment/filter";
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

describe("ema50SlopeAlignmentFilter", () => {
  it("aligns UP when slope is positive", () => {
    const snap = buildSnapshot("up", { ...emptyContext(), ema50SlopePct: 0.5 });
    expect(ema50SlopeAlignmentFilter.classify(snap, snap.context)).toBe(true);
  });

  it("aligns DOWN when slope is negative", () => {
    const snap = buildSnapshot("down", { ...emptyContext(), ema50SlopePct: -0.5 });
    expect(ema50SlopeAlignmentFilter.classify(snap, snap.context)).toBe(true);
  });

  it("skips on exactly-flat slope", () => {
    const snap = buildSnapshot("up", { ...emptyContext(), ema50SlopePct: 0 });
    expect(ema50SlopeAlignmentFilter.classify(snap, snap.context)).toBe("skip");
  });

  it("skips when slope unavailable", () => {
    const snap = buildSnapshot("up", emptyContext());
    expect(ema50SlopeAlignmentFilter.classify(snap, snap.context)).toBe("skip");
  });
});
