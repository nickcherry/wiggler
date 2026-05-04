import { computeConsensusMidSeries } from "@alea/lib/exchangePrices/computeConsensusMidSeries";
import type { ExchangeId, QuoteTick } from "@alea/types/exchanges";
import { describe, expect, it } from "bun:test";

function tick({
  exchange,
  tsReceivedMs,
  mid,
}: {
  readonly exchange: ExchangeId;
  readonly tsReceivedMs: number;
  readonly mid: number;
}): QuoteTick {
  return {
    exchange,
    tsReceivedMs,
    tsExchangeMs: null,
    bid: mid - 0.5,
    ask: mid + 0.5,
    mid,
  };
}

describe("computeConsensusMidSeries", () => {
  it("renormalizes weights across venues that have already emitted", () => {
    expect(
      computeConsensusMidSeries({
        ticks: [
          tick({ exchange: "binance-spot", tsReceivedMs: 0, mid: 100 }),
          tick({ exchange: "coinbase-spot", tsReceivedMs: 1_000, mid: 200 }),
          tick({ exchange: "binance-spot", tsReceivedMs: 2_000, mid: 104 }),
        ],
        weights: { "binance-spot": 1, "coinbase-spot": 3 },
        binMs: 1_000,
      }),
    ).toEqual([
      [0, 100],
      [1_000, 175],
      [2_000, 176],
    ]);
  });

  it("ignores zero-weight venues when choosing the output time range", () => {
    expect(
      computeConsensusMidSeries({
        ticks: [
          tick({ exchange: "okx-spot", tsReceivedMs: 0, mid: 999 }),
          tick({ exchange: "binance-spot", tsReceivedMs: 1_000, mid: 100 }),
        ],
        weights: { "binance-spot": 1, "okx-spot": 0 },
        binMs: 1_000,
      }),
    ).toEqual([[1_000, 100]]);
  });

  it("returns an empty series for empty input, nonpositive bins, or no weighted venues", () => {
    expect(
      computeConsensusMidSeries({
        ticks: [],
        weights: { "binance-spot": 1 },
        binMs: 1_000,
      }),
    ).toEqual([]);

    expect(
      computeConsensusMidSeries({
        ticks: [tick({ exchange: "binance-spot", tsReceivedMs: 0, mid: 100 })],
        weights: { "binance-spot": 1 },
        binMs: 0,
      }),
    ).toEqual([]);

    expect(
      computeConsensusMidSeries({
        ticks: [tick({ exchange: "binance-spot", tsReceivedMs: 0, mid: 100 })],
        weights: {},
        binMs: 1_000,
      }),
    ).toEqual([]);
  });
});
