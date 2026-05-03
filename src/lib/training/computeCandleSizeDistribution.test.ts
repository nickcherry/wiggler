import { computeCandleSizeDistribution } from "@alea/lib/training/computeCandleSizeDistribution";
import type { Candle } from "@alea/types/candles";
import { describe, expect, it } from "bun:test";

function buildCandle({
  timestamp,
  open,
  high,
  low,
  close,
}: {
  readonly timestamp: Date;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}): Candle {
  return {
    source: "binance",
    asset: "btc",
    product: "perp",
    timeframe: "5m",
    timestamp,
    open,
    high,
    low,
    close,
    volume: 1,
  };
}

describe("computeCandleSizeDistribution", () => {
  it("returns null when no usable candles exist", () => {
    const result = computeCandleSizeDistribution({
      asset: "btc",
      candles: [],
    });
    expect(result).toBeNull();
  });

  it("skips candles with non-positive open", () => {
    const result = computeCandleSizeDistribution({
      asset: "btc",
      candles: [
        buildCandle({
          timestamp: new Date("2025-01-01T00:00:00Z"),
          open: 0,
          high: 1,
          low: 0,
          close: 1,
        }),
        buildCandle({
          timestamp: new Date("2025-01-01T00:05:00Z"),
          open: 100,
          high: 101,
          low: 99,
          close: 100.5,
        }),
      ],
    });
    expect(result?.candleCount).toBe(1);
  });

  it("computes body and wick as percentages of open", () => {
    const result = computeCandleSizeDistribution({
      asset: "btc",
      candles: [
        // body = |102 - 100| / 100 = 2%; wick = (103 - 99) / 100 = 4%
        buildCandle({
          timestamp: new Date("2025-01-01T00:00:00Z"),
          open: 100,
          high: 103,
          low: 99,
          close: 102,
        }),
      ],
    });
    expect(result?.all.body[50]).toBeCloseTo(2, 6);
    expect(result?.all.wick[50]).toBeCloseTo(4, 6);
  });

  it("buckets candles by UTC year", () => {
    const result = computeCandleSizeDistribution({
      asset: "btc",
      candles: [
        buildCandle({
          timestamp: new Date("2024-06-15T12:00:00Z"),
          open: 100,
          high: 101,
          low: 99,
          close: 100,
        }),
        buildCandle({
          timestamp: new Date("2025-06-15T12:00:00Z"),
          open: 200,
          high: 202,
          low: 198,
          close: 200,
        }),
        buildCandle({
          timestamp: new Date("2025-12-31T23:59:00Z"),
          open: 200,
          high: 202,
          low: 198,
          close: 200,
        }),
      ],
    });
    expect(Object.keys(result?.byYear ?? {})).toEqual(["2024", "2025"]);
    expect(result?.byYear["2024"]?.candleCount).toBe(1);
    expect(result?.byYear["2025"]?.candleCount).toBe(2);
  });

  it("builds a 1 bp histogram sized to p99, with flash-crash tail in overflow", () => {
    // 100 candles. The first 99 are tightly clustered: body sweeps
    // 0.01% .. 0.99% (= 1..99 bp) one bp per candle; wick is double the
    // body. The 100th candle is a giant outlier — body 5% (= 500 bp).
    // p99 of body = 0.99% → binCount = ceil(p99(wick) / 0.01%) bins.
    // p99(wick) = 1.98% → binCount = 198.
    const candles: Candle[] = [];
    for (let i = 0; i < 99; i += 1) {
      const bodyPct = (i + 1) * 0.01;
      const wickPct = bodyPct * 2;
      candles.push(
        buildCandle({
          timestamp: new Date(
            `2025-01-01T${String(i % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`,
          ),
          open: 100,
          high: 100 + wickPct / 2,
          low: 100 - wickPct / 2,
          close: 100 + bodyPct,
        }),
      );
    }
    candles.push(
      buildCandle({
        timestamp: new Date("2025-01-02T00:00:00Z"),
        open: 100,
        high: 105,
        low: 95,
        close: 105,
      }),
    );
    const result = computeCandleSizeDistribution({ asset: "btc", candles });
    if (result === null) {
      throw new Error("expected result");
    }
    const hist = result.histogram;
    expect(hist.binWidth).toBeCloseTo(0.01, 9);
    // Range is sized to p99 of the larger metric. Linear-interpolation
    // p99 over 100 values lands at rank 98.01, so wick p99 =
    // 1.98 * 0.99 + 10.0 * 0.01 = 2.0602% → ceil(2.0602 / 0.01) = 207
    // bins. Body p99 (~1.03%) is smaller, so wick wins. Each series'
    // array includes one overflow slot at index `binCount`.
    expect(hist.binCount).toBe(207);
    expect(hist.body).toHaveLength(208);
    expect(hist.wick).toHaveLength(208);
    // Counts conserve: every candle lands in exactly one slot.
    const sum = (arr: readonly number[]) => arr.reduce((acc, n) => acc + n, 0);
    expect(sum(hist.body)).toBe(100);
    expect(sum(hist.wick)).toBe(100);
    // The 5% outlier sits past the 198 bp upper edge for both metrics →
    // overflow slot = 1 candle each.
    expect(hist.body[hist.binCount]).toBe(1);
    expect(hist.wick[hist.binCount]).toBe(1);
    // Spot-check a body bin: candle with bodyPct = 0.05% (= 5 bp) lands
    // in bin index floor(0.05 / 0.01) = 5.
    expect(hist.body[5]).toBe(1);
  });

  it("orders body percentiles non-decreasingly and below corresponding wick percentiles", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 50; i += 1) {
      candles.push(
        buildCandle({
          timestamp: new Date(
            `2025-01-01T${String(i % 24).padStart(2, "0")}:00:00Z`,
          ),
          open: 100,
          high: 100 + (i + 1) * 0.1,
          low: 100 - (i + 1) * 0.1,
          close: 100 + (i % 2 === 0 ? 1 : -1) * (i + 1) * 0.05,
        }),
      );
    }
    const result = computeCandleSizeDistribution({ asset: "btc", candles });
    expect(result).not.toBeNull();
    if (result === null) {
      return;
    }
    for (let p = 1; p <= 100; p += 1) {
      const prev = result.all.body[p - 1];
      const curr = result.all.body[p];
      if (prev === undefined || curr === undefined) {
        throw new Error("undef");
      }
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
    // wick is always >= body for any single candle, so the percentiles
    // (computed independently but on aligned distributions) should respect
    // that ordering at every p.
    for (let p = 0; p <= 100; p += 1) {
      const body = result.all.body[p];
      const wick = result.all.wick[p];
      if (body === undefined || wick === undefined) {
        throw new Error("undef");
      }
      expect(wick).toBeGreaterThanOrEqual(body - 1e-9);
    }
  });
});
