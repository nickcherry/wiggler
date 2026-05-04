import type {
  SurvivalSnapshot,
  SurvivalSnapshotContext,
} from "@alea/lib/training/computeSurvivalSnapshots";
import { utcHourUsSessionFilter } from "@alea/lib/training/survivalFilters/utcHourUsSession/filter";
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

function buildSnapshot(utcHour: number): SurvivalSnapshot {
  const ms = Date.UTC(2025, 0, 1, utcHour, 0, 0);
  return {
    windowStartMs: ms,
    year: "2025",
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

describe("utcHourUsSessionFilter", () => {
  it("true at 14 UTC (mid US session)", () => {
    const snap = buildSnapshot(14);
    expect(utcHourUsSessionFilter.classify(snap, snap.context)).toBe(true);
  });

  it("true at 13 UTC (session start)", () => {
    const snap = buildSnapshot(13);
    expect(utcHourUsSessionFilter.classify(snap, snap.context)).toBe(true);
  });

  it("false at 21 UTC (session end is exclusive)", () => {
    const snap = buildSnapshot(21);
    expect(utcHourUsSessionFilter.classify(snap, snap.context)).toBe(false);
  });

  it("false at 4 UTC (Asian session)", () => {
    const snap = buildSnapshot(4);
    expect(utcHourUsSessionFilter.classify(snap, snap.context)).toBe(false);
  });
});
