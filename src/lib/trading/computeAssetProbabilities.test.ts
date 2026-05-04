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

  it("buckets aligned vs not-aligned by EMA-50 regime", () => {
    // 50 prior 5m bars to seed EMA-50 then tens of forward windows so
    // there are enough samples per bucket to clear the floor.
    const windowStart = Date.UTC(2025, 0, 1, 0, 0, 0);
    const seed5m: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      seed5m.push(100);
    }
    const candles5m = buildFiveMinuteCandles({
      startMs: windowStart - 60 * MS_PER_5M,
      closes: seed5m,
    });

    // Forward windows: alternating ±50 close delta (50bp on a $100 line).
    const forwardWindowCount = 20;
    const windowDeltas: number[] = [];
    for (let i = 0; i < forwardWindowCount; i += 1) {
      windowDeltas.push(i % 2 === 0 ? 0.5 : -0.5);
    }
    const candles1m = buildOneMinuteCandles({
      startMs: windowStart,
      windowDeltas,
      line: 100,
    });

    const result = computeAssetProbabilities({
      asset: "btc",
      candles1m,
      candles5m,
      minBucketSamples: 1,
    });
    expect(result).not.toBeNull();
    if (result === null) {
      return;
    }
    expect(result.asset).toBe("btc");
    expect(result.windowCount).toBe(forwardWindowCount);

    // EMA-50 is exactly 100 here (flat seed), line is exactly 100. The
    // alignment filter calls `line >= ema` UP regime, so up-side
    // snapshots are aligned and down-side snapshots aren't. With the
    // half-and-half windowDeltas split, both surfaces get ~half the
    // windows and have non-empty buckets at distanceBp ≥ 1.
    const alignedAt4m = result.aligned.byRemaining[4];
    const notAlignedAt4m = result.notAligned.byRemaining[4];
    expect(alignedAt4m.length).toBeGreaterThan(0);
    expect(notAlignedAt4m.length).toBeGreaterThan(0);

    // Aligned snapshots survive (current up side wins, finalSide also up).
    for (const bucket of alignedAt4m) {
      expect(bucket.probability).toBe(1);
    }
    // Misaligned snapshots also survive in this contrived series since
    // currentSide=DOWN and finalSide=DOWN on those windows; both halves
    // are 100% survival because we set the trajectories to be monotonic.
    for (const bucket of notAlignedAt4m) {
      expect(bucket.probability).toBe(1);
    }
  });

  it("drops buckets below the sample floor", () => {
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
      windowDeltas: [0.5, 0.5, 0.5],
      line: 100,
    });

    // With a tiny universe, asking for 1000 samples per bucket should
    // wipe everything to empty surfaces — but the table itself is still
    // non-null because we did see windows.
    const result = computeAssetProbabilities({
      asset: "btc",
      candles1m,
      candles5m,
      minBucketSamples: 1000,
    });
    expect(result).not.toBeNull();
    if (result === null) {
      return;
    }
    expect(result.aligned.byRemaining[1]).toEqual([]);
    expect(result.aligned.byRemaining[2]).toEqual([]);
    expect(result.aligned.byRemaining[3]).toEqual([]);
    expect(result.aligned.byRemaining[4]).toEqual([]);
  });
});
