import type {
  SurvivalSide,
  SurvivalSnapshot,
  SurvivalSnapshotContext,
} from "@alea/lib/training/computeSurvivalSnapshots";
import { stretchedFromEma50AlignmentFilter } from "@alea/lib/training/survivalFilters/stretchedFromEma50Alignment/filter";
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

function buildSnapshot({
  currentSide,
  line = 100,
  ctx,
}: {
  readonly currentSide: SurvivalSide;
  readonly line?: number;
  readonly ctx: SurvivalSnapshotContext;
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
    context: ctx,
  };
}

describe("stretchedFromEma50AlignmentFilter", () => {
  it("UP-stretched + UP side = aligned", () => {
    const snap = buildSnapshot({
      currentSide: "up",
      line: 102,
      ctx: { ...emptyContext(), ema50x5m: 100, atr14x5m: 1 },
    });
    expect(stretchedFromEma50AlignmentFilter.classify(snap, snap.context)).toBe(true);
  });

  it("DOWN-stretched + UP side = against", () => {
    const snap = buildSnapshot({
      currentSide: "up",
      line: 98,
      ctx: { ...emptyContext(), ema50x5m: 100, atr14x5m: 1 },
    });
    expect(stretchedFromEma50AlignmentFilter.classify(snap, snap.context)).toBe(false);
  });

  it("skips when not stretched (within 1 ATR)", () => {
    const snap = buildSnapshot({
      currentSide: "up",
      line: 100.5,
      ctx: { ...emptyContext(), ema50x5m: 100, atr14x5m: 1 },
    });
    expect(stretchedFromEma50AlignmentFilter.classify(snap, snap.context)).toBe("skip");
  });

  it("skips when EMA or ATR unavailable", () => {
    const snap = buildSnapshot({ currentSide: "up", ctx: emptyContext() });
    expect(stretchedFromEma50AlignmentFilter.classify(snap, snap.context)).toBe("skip");
  });
});
