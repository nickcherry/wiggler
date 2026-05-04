import { computeAssetProbabilities } from "@alea/lib/trading/computeAssetProbabilities";
import type { Candle, CandleTimeframe } from "@alea/types/candles";
import { describe, expect, it } from "bun:test";

const MS_PER_5M = 5 * 60 * 1000;
const MS_PER_1M = 60 * 1000;

function buildCandle({
  timestamp,
  open,
  close,
  timeframe,
}: {
  readonly timestamp: Date;
  readonly open: number;
  readonly close: number;
  readonly timeframe: CandleTimeframe;
}): Candle {
  return {
    source: "binance",
    asset: "btc",
    product: "perp",
    timeframe,
    timestamp,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: 1,
  };
}

/**
 * Lays out N back-to-back 5m windows of 1m candles, where window `i` opens
 * at `line` and ends at `line + windowDeltas[i]`. Inside the window the
 * close at +1m..+4m is interpolated linearly so the snapshot at +Nm sees a
 * roughly proportional fraction of the final delta.
 */
function buildOneMinuteCandles({
  startMs,
  windowDeltas,
  line,
}: {
  readonly startMs: number;
  readonly windowDeltas: readonly number[];
  readonly line: number;
}): Candle[] {
  const out: Candle[] = [];
  for (let w = 0; w < windowDeltas.length; w += 1) {
    const delta = windowDeltas[w] ?? 0;
    const windowStart = startMs + w * MS_PER_5M;
    let prevClose = line;
    for (let m = 0; m < 5; m += 1) {
      const ts = new Date(windowStart + m * MS_PER_1M);
      const fraction = (m + 1) / 5;
      const close = line + delta * fraction;
      const open = m === 0 ? line : prevClose;
      out.push(buildCandle({ timestamp: ts, open, close, timeframe: "1m" }));
      prevClose = close;
    }
  }
  return out;
}

function buildFiveMinuteCandles({
  startMs,
  closes,
}: {
  readonly startMs: number;
  readonly closes: readonly number[];
}): Candle[] {
  const out: Candle[] = [];
  let prev = closes[0] ?? 100;
  for (let i = 0; i < closes.length; i += 1) {
    const ts = new Date(startMs + i * MS_PER_5M);
    const close = closes[i] ?? prev;
    const open = i === 0 ? close : prev;
    out.push(buildCandle({ timestamp: ts, open, close, timeframe: "5m" }));
    prev = close;
  }
  return out;
}

describe("computeAssetProbabilities", () => {
  it("returns null when there are no usable windows", () => {
    const result = computeAssetProbabilities({
      asset: "btc",
      candles1m: [],
      candles5m: [],
      minBucketSamples: 1,
    });
    expect(result).toBeNull();
  });

  it("returns null when synthetic data is too thin for sweet-spot detection", () => {
    // The sweet-spot algorithm requires per-bucket samples ≥ 2000
    // (`SWEET_SPOT_MIN_SAMPLES`). Toy snapshot streams in unit tests
    // can't realistically produce that many samples per bucket; the
    // function correctly returns null. End-to-end coverage of the
    // happy path lives at the integration level (running
    // `trading:gen-probability-table` against the real backfill).
    const windowStart = Date.UTC(2025, 0, 1, 0, 0, 0);
    const seed5m: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      seed5m.push(100);
    }
    const candles5m = buildFiveMinuteCandles({
      startMs: windowStart - 60 * MS_PER_5M,
      closes: seed5m,
    });
    const candles1m = buildOneMinuteCandles({
      startMs: windowStart,
      windowDeltas: [0.5, -0.5, 0.5, -0.5, 0.5, -0.5],
      line: 100,
    });
    const result = computeAssetProbabilities({
      asset: "btc",
      candles1m,
      candles5m,
      minBucketSamples: 1,
    });
    expect(result).toBeNull();
  });
});
