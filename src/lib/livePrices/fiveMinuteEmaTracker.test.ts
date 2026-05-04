import { createFiveMinuteEmaTracker } from "@alea/lib/livePrices/fiveMinuteEmaTracker";
import type { ClosedFiveMinuteBar } from "@alea/lib/livePrices/types";
import { describe, expect, it } from "bun:test";

const FIVE_MINUTES_MS = 5 * 60 * 1000;

function bar({
  index,
  close,
}: {
  readonly index: number;
  readonly close: number;
}): ClosedFiveMinuteBar {
  const openTimeMs = index * FIVE_MINUTES_MS;
  return {
    asset: "btc",
    openTimeMs,
    closeTimeMs: openTimeMs + FIVE_MINUTES_MS,
    open: close,
    high: close,
    low: close,
    close,
  };
}

describe("createFiveMinuteEmaTracker", () => {
  it("returns null until 50 bars have been appended", () => {
    const tracker = createFiveMinuteEmaTracker();
    for (let i = 0; i < 49; i += 1) {
      tracker.append(bar({ index: i, close: 100 }));
    }
    expect(tracker.currentValue()).toBeNull();
    tracker.append(bar({ index: 49, close: 100 }));
    expect(tracker.currentValue()).toBe(100);
  });

  it("seeds with the SMA of the first 50 closes and rolls forward", () => {
    const tracker = createFiveMinuteEmaTracker();
    // Seed: closes 1..50 → SMA = 25.5.
    for (let i = 0; i < 50; i += 1) {
      tracker.append(bar({ index: i, close: i + 1 }));
    }
    expect(tracker.currentValue()).toBeCloseTo(25.5, 9);

    // One more bar: EMA_t = α * 100 + (1 − α) * 25.5 with α = 2/51.
    const alpha = 2 / 51;
    const expected = alpha * 100 + (1 - alpha) * 25.5;
    tracker.append(bar({ index: 50, close: 100 }));
    expect(tracker.currentValue()).toBeCloseTo(expected, 9);
  });

  it("drops duplicates and out-of-order bars without corrupting state", () => {
    const tracker = createFiveMinuteEmaTracker();
    expect(tracker.append(bar({ index: 0, close: 100 }))).toBe(true);
    expect(tracker.append(bar({ index: 0, close: 999 }))).toBe(false);
    expect(tracker.append(bar({ index: 5, close: 200 }))).toBe(true);
    expect(tracker.append(bar({ index: 4, close: 999 }))).toBe(false);
    expect(tracker.barCount()).toBe(2);
    expect(tracker.lastBarOpenMs()).toBe(5 * FIVE_MINUTES_MS);
  });

  it("exposes barCount and lastBarOpenMs accessors", () => {
    const tracker = createFiveMinuteEmaTracker();
    expect(tracker.barCount()).toBe(0);
    expect(tracker.lastBarOpenMs()).toBeNull();
    tracker.append(bar({ index: 7, close: 50 }));
    expect(tracker.barCount()).toBe(1);
    expect(tracker.lastBarOpenMs()).toBe(7 * FIVE_MINUTES_MS);
  });
});
