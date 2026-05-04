import type {
  SurvivalSide,
  SurvivalSnapshot,
  SurvivalSnapshotContext,
} from "@alea/lib/training/computeSurvivalSnapshots";
import { europeanSessionFilter } from "@alea/lib/training/survivalFilters/europeanSession/filter";
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

function buildSnapshot(windowStartMs: number, currentSide: SurvivalSide): SurvivalSnapshot {
  return {
    windowStartMs,
    year: "2025",
    line: 100,
    finalPrice: 100,
    finalSide: currentSide,
    snapshotPrice: 100,
    currentSide,
    distanceBp: 0,
    remaining: 1,
    survived: true,
    context: emptyContext(),
  };
}

describe("europeanSessionFilter", () => {
  it("classifies windows starting in 07:00–16:00 UTC as in-session", () => {
    const snap = buildSnapshot(Date.UTC(2025, 0, 1, 10, 0, 0), "up");
    expect(europeanSessionFilter.classify(snap, snap.context)).toBe(true);
  });

  it("classifies 06:55 UTC (before session) as out-of-session", () => {
    const snap = buildSnapshot(Date.UTC(2025, 0, 1, 6, 55, 0), "up");
    expect(europeanSessionFilter.classify(snap, snap.context)).toBe(false);
  });

  it("classifies 16:00 UTC (boundary) as out-of-session", () => {
    const snap = buildSnapshot(Date.UTC(2025, 0, 1, 16, 0, 0), "up");
    expect(europeanSessionFilter.classify(snap, snap.context)).toBe(false);
  });

  it("classifies 07:00 UTC (boundary) as in-session", () => {
    const snap = buildSnapshot(Date.UTC(2025, 0, 1, 7, 0, 0), "up");
    expect(europeanSessionFilter.classify(snap, snap.context)).toBe(true);
  });
});
