import { LIVE_TRADING_ATR_PERIOD } from "@alea/constants/liveTrading";
import { createFiveMinuteAtrTracker } from "@alea/lib/livePrices/fiveMinuteAtrTracker";
import type { ClosedFiveMinuteBar } from "@alea/lib/livePrices/types";
import { describe, expect, it } from "bun:test";

function bar({
  openTimeMs,
  open,
  high,
  low,
  close,
}: {
  readonly openTimeMs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}): ClosedFiveMinuteBar {
  return {
    asset: "btc",
    openTimeMs,
    closeTimeMs: openTimeMs + 5 * 60 * 1000,
    open,
    high,
    low,
    close,
  };
}

/**
 * Reference implementation of the training pipeline's Wilder ATR —
 * copied verbatim from `computeWilderAtrSeries` in
 * `computeSurvivalSnapshots.ts` so this test is the cross-pipeline
 * equality check itself. If the production tracker drifts from the
 * training formula at the configured `LIVE_TRADING_ATR_PERIOD`, this
 * test catches it.
 */
function referenceAtrSeries({
  highs,
  lows,
  closes,
  period,
}: {
  readonly highs: readonly number[];
  readonly lows: readonly number[];
  readonly closes: readonly number[];
  readonly period: number;
}): (number | null)[] {
  const n = closes.length;
  const out: (number | null)[] = new Array<number | null>(n).fill(null);
  if (n < period) {return out;}
  const tr: number[] = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    const h = highs[i]!;
    const l = lows[i]!;
    if (i === 0) {
      tr[i] = h - l;
      continue;
    }
    const prevClose = closes[i - 1]!;
    tr[i] = Math.max(h - l, Math.abs(h - prevClose), Math.abs(prevClose - l));
  }
  let sum = 0;
  for (let i = 0; i < period; i += 1) {sum += tr[i]!;}
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < n; i += 1) {
    prev = (prev * (period - 1) + tr[i]!) / period;
    out[i] = prev;
  }
  return out;
}

describe("FiveMinuteAtrTracker", () => {
  it("returns null until LIVE_TRADING_ATR_PERIOD bars have been seen", () => {
    const tracker = createFiveMinuteAtrTracker();
    for (let i = 0; i < LIVE_TRADING_ATR_PERIOD - 1; i += 1) {
      tracker.append(bar({ openTimeMs: i * 300_000, open: 100, high: 102, low: 98, close: 100 }));
      expect(tracker.currentValue()).toBeNull();
    }
    tracker.append(bar({ openTimeMs: (LIVE_TRADING_ATR_PERIOD - 1) * 300_000, open: 100, high: 102, low: 98, close: 100 }));
    expect(tracker.currentValue()).not.toBeNull();
  });

  it("matches the training pipeline's Wilder ATR bar-for-bar at the configured period", () => {
    // Synthetic bar series with varied range so true-range != hi-lo for
    // most bars. Includes gap-ups and gap-downs to exercise the
    // |high − prevClose| and |prevClose − low| branches of the TR
    // formula.
    const series = [
      { openTimeMs: 0, open: 100, high: 102, low: 99, close: 101 },
      { openTimeMs: 1, open: 101, high: 103, low: 100, close: 102 },
      { openTimeMs: 2, open: 102, high: 105, low: 101, close: 104 },
      { openTimeMs: 3, open: 104, high: 104, low: 100, close: 101 },
      { openTimeMs: 4, open: 101, high: 102, low: 95, close: 97 },
      { openTimeMs: 5, open: 97, high: 100, low: 96, close: 99 },
      { openTimeMs: 6, open: 99, high: 105, low: 99, close: 104 },
      { openTimeMs: 7, open: 104, high: 110, low: 103, close: 109 },
      { openTimeMs: 8, open: 109, high: 110, low: 106, close: 107 },
      { openTimeMs: 9, open: 107, high: 108, low: 100, close: 102 },
      { openTimeMs: 10, open: 102, high: 103, low: 99, close: 100 },
      { openTimeMs: 11, open: 100, high: 102, low: 98, close: 101 },
      { openTimeMs: 12, open: 101, high: 105, low: 100, close: 104 },
      { openTimeMs: 13, open: 104, high: 106, low: 102, close: 105 },
      { openTimeMs: 14, open: 105, high: 108, low: 104, close: 107 },
      { openTimeMs: 15, open: 107, high: 109, low: 100, close: 102 },
      { openTimeMs: 16, open: 102, high: 104, low: 100, close: 103 },
      { openTimeMs: 17, open: 103, high: 105, low: 101, close: 104 },
      { openTimeMs: 18, open: 104, high: 107, low: 103, close: 106 },
      { openTimeMs: 19, open: 106, high: 108, low: 105, close: 107 },
    ];

    const reference = referenceAtrSeries({
      highs: series.map((b) => b.high),
      lows: series.map((b) => b.low),
      closes: series.map((b) => b.close),
      period: LIVE_TRADING_ATR_PERIOD,
    });

    const tracker = createFiveMinuteAtrTracker();
    for (let i = 0; i < series.length; i += 1) {
      tracker.append(bar(series[i]!));
      const expected = reference[i]!;
      const actual = tracker.currentValue();
      if (expected === null) {
        expect(actual).toBeNull();
      } else {
        expect(actual).not.toBeNull();
        // 1e-9 tolerance: same arithmetic in both implementations,
        // floating-point identical in practice.
        expect(actual!).toBeCloseTo(expected, 9);
      }
    }
  });

  it("drops out-of-order and duplicate bars", () => {
    const tracker = createFiveMinuteAtrTracker();
    expect(
      tracker.append(bar({ openTimeMs: 1000, open: 100, high: 102, low: 98, close: 101 })),
    ).toBe(true);
    // Duplicate (same openTimeMs) — drop.
    expect(
      tracker.append(bar({ openTimeMs: 1000, open: 100, high: 200, low: 50, close: 100 })),
    ).toBe(false);
    // Out-of-order (older) — drop.
    expect(
      tracker.append(bar({ openTimeMs: 500, open: 100, high: 200, low: 50, close: 100 })),
    ).toBe(false);
    // Forward — accept.
    expect(
      tracker.append(bar({ openTimeMs: 1500, open: 101, high: 103, low: 100, close: 102 })),
    ).toBe(true);
    expect(tracker.barCount()).toBe(2);
    expect(tracker.lastBarOpenMs()).toBe(1500);
  });
});
