import type {
  SurvivalSide,
  SurvivalSnapshot,
  SurvivalSnapshotContext,
} from "@alea/lib/training/computeSurvivalSnapshots";
import { ma205mAlignmentFilter } from "@alea/lib/training/survivalFilters/ma205mAlignment/filter";
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

function buildSnapshot({
  currentSide,
  line = 100,
  context,
}: {
  readonly currentSide: SurvivalSide;
  readonly line?: number;
  readonly context: SurvivalSnapshotContext;
}): SurvivalSnapshot {
  return {
    windowStartMs: 0,
    year: "2025",
    line,
    finalPrice: line,
    finalSide: currentSide,
    snapshotPrice: line,
    currentSide,
    distanceBp: 0,
    remaining: 1,
    survived: true,
    context,
  };
}

describe("ma205mAlignmentFilter", () => {
  it("aligns UP when line >= MA", () => {
    const snap = buildSnapshot({
      currentSide: "up",
      line: 105,
      context: { ...emptyContext(), ma20x5m: 100 },
    });
    expect(ma205mAlignmentFilter.classify(snap, snap.context)).toBe(true);
  });

  it("DOWN against bullish regime is not aligned", () => {
    const snap = buildSnapshot({
      currentSide: "down",
      line: 105,
      context: { ...emptyContext(), ma20x5m: 100 },
    });
    expect(ma205mAlignmentFilter.classify(snap, snap.context)).toBe(false);
  });

  it("aligns DOWN when line < MA", () => {
    const snap = buildSnapshot({
      currentSide: "down",
      line: 95,
      context: { ...emptyContext(), ma20x5m: 100 },
    });
    expect(ma205mAlignmentFilter.classify(snap, snap.context)).toBe(true);
  });

  it("skips when MA unavailable", () => {
    const snap = buildSnapshot({
      currentSide: "up",
      context: emptyContext(),
    });
    expect(ma205mAlignmentFilter.classify(snap, snap.context)).toBe("skip");
  });
});
