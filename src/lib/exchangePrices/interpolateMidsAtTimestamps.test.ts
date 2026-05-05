import { interpolateMidsAtTimestamps } from "@alea/lib/exchangePrices/interpolateMidsAtTimestamps";
import type { QuoteTick } from "@alea/types/exchanges";
import { describe, expect, it } from "bun:test";

function tick(tsReceivedMs: number, mid: number): QuoteTick {
  return {
    exchange: "coinbase-spot",
    asset: "btc",
    tsReceivedMs,
    tsExchangeMs: null,
    bid: mid - 0.5,
    ask: mid + 0.5,
    mid,
  };
}

describe("interpolateMidsAtTimestamps", () => {
  it("linearly interpolates inside the tick range and nulls outside it", () => {
    expect(
      interpolateMidsAtTimestamps({
        ticks: [tick(1_000, 20), tick(0, 10), tick(2_000, 30)],
        timestampsMs: [-1, 0, 500, 1_000, 1_500, 2_000, 2_001],
      }),
    ).toEqual([null, 10, 15, 20, 25, 30, null]);
  });

  it("returns all nulls when no ticks are available", () => {
    expect(
      interpolateMidsAtTimestamps({
        ticks: [],
        timestampsMs: [0, 1, 2],
      }),
    ).toEqual([null, null, null]);
  });
});
