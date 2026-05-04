import {
  currentWindowStartMs,
  FIVE_MINUTES_MS,
  flooredRemainingMinutes,
  nextWindowStartMs,
  remainingInWindowMs,
} from "@alea/lib/livePrices/fiveMinuteWindow";
import { describe, expect, it } from "bun:test";

const T_BOUNDARY = Date.UTC(2026, 0, 1, 0, 5, 0);

describe("fiveMinuteWindow", () => {
  it("currentWindowStartMs floors to the most recent boundary", () => {
    expect(currentWindowStartMs({ nowMs: T_BOUNDARY })).toBe(T_BOUNDARY);
    expect(currentWindowStartMs({ nowMs: T_BOUNDARY + 1 })).toBe(T_BOUNDARY);
    expect(
      currentWindowStartMs({ nowMs: T_BOUNDARY + FIVE_MINUTES_MS - 1 }),
    ).toBe(T_BOUNDARY);
  });

  it("nextWindowStartMs always returns a strictly-future boundary", () => {
    expect(nextWindowStartMs({ nowMs: T_BOUNDARY })).toBe(
      T_BOUNDARY + FIVE_MINUTES_MS,
    );
    expect(nextWindowStartMs({ nowMs: T_BOUNDARY + 1 })).toBe(
      T_BOUNDARY + FIVE_MINUTES_MS,
    );
  });

  it("remainingInWindowMs counts down from 5min to 0 across the window", () => {
    expect(
      remainingInWindowMs({ windowStartMs: T_BOUNDARY, nowMs: T_BOUNDARY }),
    ).toBe(FIVE_MINUTES_MS);
    expect(
      remainingInWindowMs({
        windowStartMs: T_BOUNDARY,
        nowMs: T_BOUNDARY + 60_000,
      }),
    ).toBe(4 * 60_000);
  });

  it("flooredRemainingMinutes mirrors the training snapshot convention", () => {
    const cases: { offsetMs: number; expected: 1 | 2 | 3 | 4 | null }[] = [
      { offsetMs: 0, expected: null },
      { offsetMs: 30_000, expected: null },
      { offsetMs: 59_999, expected: null },
      { offsetMs: 60_000, expected: 4 },
      { offsetMs: 119_999, expected: 4 },
      { offsetMs: 120_000, expected: 3 },
      { offsetMs: 180_000, expected: 2 },
      { offsetMs: 239_999, expected: 2 },
      { offsetMs: 240_000, expected: 1 },
      { offsetMs: 299_999, expected: 1 },
      { offsetMs: 300_000, expected: null },
    ];
    for (const { offsetMs, expected } of cases) {
      expect(
        flooredRemainingMinutes({
          windowStartMs: T_BOUNDARY,
          nowMs: T_BOUNDARY + offsetMs,
        }),
      ).toBe(expected);
    }
  });

  it("flooredRemainingMinutes returns null before the window opens", () => {
    expect(
      flooredRemainingMinutes({
        windowStartMs: T_BOUNDARY,
        nowMs: T_BOUNDARY - 1,
      }),
    ).toBeNull();
  });
});
