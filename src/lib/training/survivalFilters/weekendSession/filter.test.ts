import type {
  SurvivalSnapshot,
  SurvivalSnapshotContext,
} from "@alea/lib/training/computeSurvivalSnapshots";
import { weekendSessionFilter } from "@alea/lib/training/survivalFilters/weekendSession/filter";
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

function buildSnapshot(year: number, month: number, day: number): SurvivalSnapshot {
  const ms = Date.UTC(year, month, day, 12, 0, 0);
  return {
    windowStartMs: ms,
    year: String(year),
    line: 100,
    finalPrice: 100,
    finalSide: "up",
    snapshotPrice: 100,
    currentSide: "up",
    distanceBp: 0,
    remaining: 1,
    survived: true,
    context: emptyContext(),
  };
}

describe("weekendSessionFilter", () => {
  it("true on Saturday", () => {
    // 2025-01-04 is a Saturday
    const snap = buildSnapshot(2025, 0, 4);
    expect(weekendSessionFilter.classify(snap, snap.context)).toBe(true);
  });

  it("true on Sunday", () => {
    // 2025-01-05 is a Sunday
    const snap = buildSnapshot(2025, 0, 5);
    expect(weekendSessionFilter.classify(snap, snap.context)).toBe(true);
  });

  it("false on Monday", () => {
    // 2025-01-06 is a Monday
    const snap = buildSnapshot(2025, 0, 6);
    expect(weekendSessionFilter.classify(snap, snap.context)).toBe(false);
  });
});
