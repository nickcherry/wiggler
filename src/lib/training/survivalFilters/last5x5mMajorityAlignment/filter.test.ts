import type {
  SurvivalSide,
  SurvivalSnapshot,
  SurvivalSnapshotContext,
} from "@alea/lib/training/computeSurvivalSnapshots";
import { last5x5mMajorityAlignmentFilter } from "@alea/lib/training/survivalFilters/last5x5mMajorityAlignment/filter";
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
    prev5mBarVolume: null,
    avgVolume50x5m: null,
    avgRangeRecent5x5m: null,
    avgRangePrior5x5m: null,
    bars5mSinceDonchian50High: null,
    bars5mSinceDonchian50Low: null,
    currentMicroBarDirection: "up",
    prevMicroDistanceBp: null,
  };
}

function buildSnapshot({
  currentSide,
  context,
}: {
  readonly currentSide: SurvivalSide;
  readonly context: SurvivalSnapshotContext;
}): SurvivalSnapshot {
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
    context,
  };
}

describe("last5x5mMajorityAlignmentFilter", () => {
  it("aligns when at least three of five previous candles match the side", () => {
    const snap = buildSnapshot({
      currentSide: "up",
      context: {
        ...emptyContext(),
        last5x5mDirections: ["up", "down", "up", "down", "up"],
      },
    });
    expect(last5x5mMajorityAlignmentFilter.classify(snap, snap.context)).toBe(
      true,
    );
  });

  it("does not align when the five-candle majority is opposite", () => {
    const snap = buildSnapshot({
      currentSide: "up",
      context: {
        ...emptyContext(),
        last5x5mDirections: ["down", "down", "up", "down", "up"],
      },
    });
    expect(last5x5mMajorityAlignmentFilter.classify(snap, snap.context)).toBe(
      false,
    );
  });

  it("aligns DOWN when down has the five-candle majority", () => {
    const snap = buildSnapshot({
      currentSide: "down",
      context: {
        ...emptyContext(),
        last5x5mDirections: ["down", "down", "up", "down", "up"],
      },
    });
    expect(last5x5mMajorityAlignmentFilter.classify(snap, snap.context)).toBe(
      true,
    );
  });

  it("skips when fewer than five preceding 5m bars are available", () => {
    const snap = buildSnapshot({
      currentSide: "up",
      context: emptyContext(),
    });
    expect(last5x5mMajorityAlignmentFilter.classify(snap, snap.context)).toBe(
      "skip",
    );
  });
});
