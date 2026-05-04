import type {
  SurvivalSide,
  SurvivalSnapshot,
  SurvivalSnapshotContext,
} from "@alea/lib/training/computeSurvivalSnapshots";
import { roc205mAlignmentFilter } from "@alea/lib/training/survivalFilters/roc205mAlignment/filter";
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

describe("roc205mAlignmentFilter", () => {
  it("positive ROC + UP side = aligned", () => {
    const snap = buildSnapshot("up", { ...emptyContext(), roc20Pct: 0.8 });
    expect(roc205mAlignmentFilter.classify(snap, snap.context)).toBe(true);
  });

  it("negative ROC + DOWN side = aligned", () => {
    const snap = buildSnapshot("down", { ...emptyContext(), roc20Pct: -1.2 });
    expect(roc205mAlignmentFilter.classify(snap, snap.context)).toBe(true);
  });

  it("skips on exactly-zero ROC", () => {
    const snap = buildSnapshot("up", { ...emptyContext(), roc20Pct: 0 });
    expect(roc205mAlignmentFilter.classify(snap, snap.context)).toBe("skip");
  });

  it("skips when ROC unavailable", () => {
    const snap = buildSnapshot("up", emptyContext());
    expect(roc205mAlignmentFilter.classify(snap, snap.context)).toBe("skip");
  });
});
