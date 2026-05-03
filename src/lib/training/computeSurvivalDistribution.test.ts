import { computeSurvivalDistribution } from "@alea/lib/training/computeSurvivalDistribution";
import type { Candle } from "@alea/types/candles";
import { describe, expect, it } from "bun:test";

function buildCandle({
  timestamp,
  open,
  close,
}: {
  readonly timestamp: Date;
  readonly open: number;
  readonly close: number;
}): Candle {
  return {
    source: "binance",
    asset: "btc",
    product: "perp",
    timeframe: "1m",
    timestamp,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: 1,
  };
}

/**
 * Builds a single 5m window of 1m candles starting at `windowStart`. Each
 * candle's `open` is set to the prior `close` so the series is gap-free,
 * but only the supplied `closes` matter for survival logic.
 */
function buildWindow({
  windowStart,
  lineOpen,
  closes,
}: {
  readonly windowStart: Date;
  readonly lineOpen: number;
  readonly closes: readonly [number, number, number, number, number];
}): Candle[] {
  const [c0, c1, c2, c3, c4] = closes;
  const orderedCloses: readonly number[] = [c0, c1, c2, c3, c4];
  const out: Candle[] = [];
  let prevClose = lineOpen;
  for (let i = 0; i < 5; i += 1) {
    const ts = new Date(windowStart.getTime() + i * 60_000);
    const open = i === 0 ? lineOpen : prevClose;
    const close = orderedCloses[i] ?? prevClose;
    out.push(buildCandle({ timestamp: ts, open, close }));
    prevClose = close;
  }
  return out;
}

describe("computeSurvivalDistribution", () => {
  it("returns null when no usable windows exist", () => {
    expect(
      computeSurvivalDistribution({ asset: "btc", candles: [] }),
    ).toBeNull();
  });

  it("ties favor UP: snapshot at the line counts as up", () => {
    // line = 100, every snapshot exactly at 100, final exactly at 100.
    // All snapshots are UP and the final is UP, so all four survive at
    // distance 0.
    const candles = buildWindow({
      windowStart: new Date("2025-01-01T00:00:00Z"),
      lineOpen: 100,
      closes: [100, 100, 100, 100, 100],
    });
    const result = computeSurvivalDistribution({ asset: "btc", candles });
    expect(result).not.toBeNull();
    if (result === null) {
      return;
    }
    expect(result.windowCount).toBe(1);
    for (const remaining of [1, 2, 3, 4] as const) {
      const buckets = result.all.byRemaining[remaining];
      expect(buckets.length).toBe(1);
      expect(buckets[0]?.distanceBp).toBe(0);
      expect(buckets[0]?.total).toBe(1);
      expect(buckets[0]?.survived).toBe(1);
    }
  });

  it("maps snapshot index to remaining minutes (+1m → 4m left, +4m → 1m left)", () => {
    // line = 100; snapshots progress 100.10, 100.05, 99.95, 100.20; final 100.30.
    // Final side is UP (100.30 >= 100). So snapshots at +1m (100.10 UP) and
    // +2m (100.05 UP) survive, +3m (99.95 DOWN) does not, +4m (100.20 UP)
    // does. Verify the mapping is by remaining-minutes label, not index.
    const candles = buildWindow({
      windowStart: new Date("2025-01-01T00:00:00Z"),
      lineOpen: 100,
      closes: [100.1, 100.05, 99.95, 100.2, 100.3],
    });
    const result = computeSurvivalDistribution({ asset: "btc", candles });
    if (result === null) {
      throw new Error("expected result");
    }
    const survivedAt = (rem: 1 | 2 | 3 | 4) =>
      result.all.byRemaining[rem].reduce((acc, b) => acc + b.survived, 0);
    expect(survivedAt(4)).toBe(1); // +1m snapshot, currentSide UP
    expect(survivedAt(3)).toBe(1); // +2m snapshot, UP
    expect(survivedAt(2)).toBe(0); // +3m snapshot, DOWN
    expect(survivedAt(1)).toBe(1); // +4m snapshot, UP
  });

  it("buckets distance via floor of bps", () => {
    // line = 100; +1m snapshot at 100.015 → 1.5 bp → floor → 1 bp bucket.
    // +2m at 100.029 → 2.9 → 2; +3m at 100.05 → 5.0 → 5; +4m at 100.099 → 9.9 → 9.
    const candles = buildWindow({
      windowStart: new Date("2025-01-01T00:00:00Z"),
      lineOpen: 100,
      closes: [100.015, 100.029, 100.05, 100.099, 100.2],
    });
    const result = computeSurvivalDistribution({ asset: "btc", candles });
    if (result === null) {
      throw new Error("expected result");
    }
    expect(result.all.byRemaining[4][0]?.distanceBp).toBe(1);
    expect(result.all.byRemaining[3][0]?.distanceBp).toBe(2);
    expect(result.all.byRemaining[2][0]?.distanceBp).toBe(5);
    expect(result.all.byRemaining[1][0]?.distanceBp).toBe(9);
  });

  it("uses absolute distance (DOWN side maps to the same bucket as UP)", () => {
    // Two windows. Window A: +1m close = 100.05 (UP, 5 bp). Window B: +1m
    // close = 99.95 (DOWN, 5 bp). Both should land in the 5 bp bucket at
    // 4m-left.
    const a = buildWindow({
      windowStart: new Date("2025-01-01T00:00:00Z"),
      lineOpen: 100,
      closes: [100.05, 100, 100, 100, 100],
    });
    const b = buildWindow({
      windowStart: new Date("2025-01-01T00:05:00Z"),
      lineOpen: 100,
      closes: [99.95, 100, 100, 100, 100],
    });
    const result = computeSurvivalDistribution({
      asset: "btc",
      candles: [...a, ...b],
    });
    if (result === null) {
      throw new Error("expected result");
    }
    const at5bp = result.all.byRemaining[4].find((b) => b.distanceBp === 5);
    expect(at5bp?.total).toBe(2);
  });

  it("skips windows that are not aligned to a 5m boundary", () => {
    // First candle starts at 00:01:00 — not a 5m boundary. Should be
    // ignored entirely.
    const candles = buildWindow({
      windowStart: new Date("2025-01-01T00:01:00Z"),
      lineOpen: 100,
      closes: [100, 100, 100, 100, 100],
    });
    expect(computeSurvivalDistribution({ asset: "btc", candles })).toBeNull();
  });

  it("skips windows with a missing 1m candle", () => {
    const full = buildWindow({
      windowStart: new Date("2025-01-01T00:00:00Z"),
      lineOpen: 100,
      closes: [100, 100, 100, 100, 100],
    });
    // Drop the 3rd candle (00:02:00). Remaining four no longer form a
    // gapless 5m window.
    const candles = full.filter((_, i) => i !== 2);
    expect(computeSurvivalDistribution({ asset: "btc", candles })).toBeNull();
  });

  it("skips windows with non-positive line price", () => {
    const candles = buildWindow({
      windowStart: new Date("2025-01-01T00:00:00Z"),
      lineOpen: 0,
      closes: [0, 0, 0, 0, 0],
    });
    expect(computeSurvivalDistribution({ asset: "btc", candles })).toBeNull();
  });

  it("buckets windows by UTC year of start timestamp", () => {
    const a = buildWindow({
      windowStart: new Date("2024-06-15T12:00:00Z"),
      lineOpen: 100,
      closes: [100, 100, 100, 100, 100],
    });
    const b = buildWindow({
      windowStart: new Date("2025-06-15T12:00:00Z"),
      lineOpen: 200,
      closes: [200, 200, 200, 200, 200],
    });
    const result = computeSurvivalDistribution({
      asset: "btc",
      candles: [...a, ...b],
    });
    if (result === null) {
      throw new Error("expected result");
    }
    expect(Object.keys(result.byYear).sort()).toEqual(["2024", "2025"]);
    expect(result.byYear["2024"]?.windowCount).toBe(1);
    expect(result.byYear["2025"]?.windowCount).toBe(1);
  });
});
