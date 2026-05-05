import { densifyMidsLinearly } from "@alea/lib/exchangePrices/densifyMidsLinearly";
import type { QuoteTick } from "@alea/types/exchanges";
import { describe, expect, it } from "bun:test";

function tick(tsReceivedMs: number, mid: number): QuoteTick {
  return {
    exchange: "binance-spot",
    asset: "btc",
    tsReceivedMs,
    tsExchangeMs: null,
    bid: mid - 0.5,
    ask: mid + 0.5,
    mid,
  };
}

describe("densifyMidsLinearly", () => {
  it("interpolates sparse ticks onto a uniform grid", () => {
    expect(
      densifyMidsLinearly({
        ticks: [tick(1_000, 20), tick(0, 10)],
        binMs: 250,
      }),
    ).toEqual([
      [0, 10],
      [250, 12.5],
      [500, 15],
      [750, 17.5],
      [1_000, 20],
    ]);
  });

  it("appends the exact final tick when the bin grid does not land on it", () => {
    expect(
      densifyMidsLinearly({
        ticks: [tick(0, 10), tick(1_000, 20)],
        binMs: 700,
      }),
    ).toEqual([
      [0, 10],
      [700, 17],
      [1_000, 20],
    ]);
  });

  it("returns original coordinates when there is nothing to interpolate", () => {
    expect(densifyMidsLinearly({ ticks: [tick(500, 12)], binMs: 100 })).toEqual(
      [[500, 12]],
    );
  });

  it("rejects nonpositive bin sizes", () => {
    expect(() =>
      densifyMidsLinearly({ ticks: [tick(0, 10)], binMs: 0 }),
    ).toThrow(/binMs must be positive/);
  });
});
