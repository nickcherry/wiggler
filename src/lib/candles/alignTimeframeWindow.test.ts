import { alignTimeframeWindow } from "@alea/lib/candles/alignTimeframeWindow";
import { timeframeMs } from "@alea/lib/candles/timeframeMs";
import { describe, expect, it } from "bun:test";

describe("alignTimeframeWindow", () => {
  it("floors dates to the most recent 1m boundary", () => {
    expect(
      alignTimeframeWindow({
        date: new Date("2026-05-04T12:34:56.789Z"),
        timeframe: "1m",
      }).toISOString(),
    ).toBe("2026-05-04T12:34:00.000Z");
  });

  it("floors dates to the most recent 5m boundary", () => {
    expect(
      alignTimeframeWindow({
        date: new Date("2026-05-04T12:34:56.789Z"),
        timeframe: "5m",
      }).toISOString(),
    ).toBe("2026-05-04T12:30:00.000Z");
  });
});

describe("timeframeMs", () => {
  it("returns the candle duration in milliseconds", () => {
    expect(timeframeMs({ timeframe: "1m" })).toBe(60_000);
    expect(timeframeMs({ timeframe: "5m" })).toBe(300_000);
  });
});
