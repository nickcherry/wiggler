import type {
  SurvivalSide,
  SurvivalSnapshot,
  SurvivalSnapshotContext,
} from "@alea/lib/training/computeSurvivalSnapshots";
import { donchian50TopAlignmentFilter } from "@alea/lib/training/survivalFilters/donchian50TopAlignment/filter";
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

describe("donchian50TopAlignmentFilter", () => {
  it("line in top half + UP = aligned", () => {
    const snap = buildSnapshot({
      currentSide: "up",
      line: 110,
      ctx: { ...emptyContext(), donchian50High: 120, donchian50Low: 100 },
    });
    expect(donchian50TopAlignmentFilter.classify(snap, snap.context)).toBe(true);
  });

  it("line in bottom half + DOWN = aligned", () => {
    const snap = buildSnapshot({
      currentSide: "down",
      line: 102,
      ctx: { ...emptyContext(), donchian50High: 120, donchian50Low: 100 },
    });
    expect(donchian50TopAlignmentFilter.classify(snap, snap.context)).toBe(true);
  });

  it("skips on degenerate range", () => {
    const snap = buildSnapshot({
      currentSide: "up",
      line: 100,
      ctx: { ...emptyContext(), donchian50High: 100, donchian50Low: 100 },
    });
    expect(donchian50TopAlignmentFilter.classify(snap, snap.context)).toBe("skip");
  });

  it("skips when range unavailable", () => {
    const snap = buildSnapshot({ currentSide: "up", ctx: emptyContext() });
    expect(donchian50TopAlignmentFilter.classify(snap, snap.context)).toBe("skip");
  });
});
