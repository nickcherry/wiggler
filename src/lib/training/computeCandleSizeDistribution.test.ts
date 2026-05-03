import { computeCandleSizeDistribution } from "@wiggler/lib/training/computeCandleSizeDistribution";
import type { Candle } from "@wiggler/types/candles";
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
