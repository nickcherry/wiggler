import type {
  SurvivalSide,
  SurvivalSnapshot,
  SurvivalSnapshotContext,
} from "@alea/lib/training/computeSurvivalSnapshots";
import { volCompressionFilter } from "@alea/lib/training/survivalFilters/volCompression/filter";
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

describe("volCompressionFilter", () => {
  it("true when ATR-14 < ATR-50 (compressed regime)", () => {
    const snap = buildSnapshot("up", { ...emptyContext(), atr14x5m: 4, atr50x5m: 6 });
    expect(volCompressionFilter.classify(snap, snap.context)).toBe(true);
  });

  it("false when ATR-14 ≥ ATR-50 (expanded regime)", () => {
    const snap = buildSnapshot("up", { ...emptyContext(), atr14x5m: 8, atr50x5m: 6 });
    expect(volCompressionFilter.classify(snap, snap.context)).toBe(false);
  });

  it("skips when either ATR unavailable", () => {
    const snap = buildSnapshot("up", { ...emptyContext(), atr14x5m: 4 });
    expect(volCompressionFilter.classify(snap, snap.context)).toBe("skip");
  });
});
