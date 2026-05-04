import { createFiveMinuteEmaTracker } from "@alea/lib/livePrices/fiveMinuteEmaTracker";
import type {
  ClosedFiveMinuteBar,
  LivePriceTick,
} from "@alea/lib/livePrices/types";
import {
  emaReadyForWindow,
  exactSettlementBar,
  tickCanCaptureLine,
  usableBookForMarket,
} from "@alea/lib/trading/live/freshness";
import type { TradableMarket, UpDownBook } from "@alea/lib/trading/vendor/types";
import { describe, expect, it } from "bun:test";

const WINDOW_START = Date.UTC(2026, 0, 1, 0, 0, 0);

const market: TradableMarket = {
  asset: "btc",
  windowStartUnixSeconds: Math.floor(WINDOW_START / 1000),
  windowStartMs: WINDOW_START,
  windowEndMs: WINDOW_START + 5 * 60_000,
  vendorRef: "condition-current",
  upRef: "UP",
  downRef: "DOWN",
  acceptingOrders: true,
};

function tick(overrides: Partial<LivePriceTick>): LivePriceTick {
  return {
    asset: "btc",
    bid: 100,
    ask: 100.01,
    mid: 100.005,
    exchangeTimeMs: WINDOW_START + 1_000,
    receivedAtMs: WINDOW_START + 1_050,
    ...overrides,
  };
}

function book(overrides: Partial<UpDownBook>): UpDownBook {
  return {
    market,
    up: { bestBid: 0.5, bestAsk: 0.51 },
    down: { bestBid: 0.49, bestAsk: 0.5 },
    fetchedAtMs: WINDOW_START + 60_000,
    ...overrides,
  };
}

function bar(openTimeMs: number): ClosedFiveMinuteBar {
  return {
    asset: "btc",
    openTimeMs,
    closeTimeMs: openTimeMs + 5 * 60_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
  };
}

describe("live freshness guards", () => {
  it("captures the line only from a fresh in-window tick near the boundary", () => {
    expect(
      tickCanCaptureLine({
        tick: tick({ exchangeTimeMs: WINDOW_START - 1 }),
        windowStartMs: WINDOW_START,
        nowMs: WINDOW_START + 1_200,
      }),
    ).toBe(false);
    expect(
      tickCanCaptureLine({
        tick: tick({
          exchangeTimeMs: WINDOW_START + 10_000,
          receivedAtMs: WINDOW_START + 10_050,
        }),
        windowStartMs: WINDOW_START,
        nowMs: WINDOW_START + 10_100,
      }),
    ).toBe(false);
    expect(
      tickCanCaptureLine({
        tick: tick({}),
        windowStartMs: WINDOW_START,
        nowMs: WINDOW_START + 1_200,
      }),
    ).toBe(true);
  });

  it("uses only current-market books that are fresh enough", () => {
    expect(
      usableBookForMarket({
        book: book({}),
        vendorRef: market.vendorRef,
        windowStartMs: market.windowStartMs,
        nowMs: WINDOW_START + 61_000,
      }),
    ).not.toBeNull();
    expect(
      usableBookForMarket({
        book: book({
          market: { ...market, vendorRef: "condition-old" },
        }),
        vendorRef: market.vendorRef,
        windowStartMs: market.windowStartMs,
        nowMs: WINDOW_START + 61_000,
      }),
    ).toBeNull();
    expect(
      usableBookForMarket({
        book: book({ fetchedAtMs: WINDOW_START + 1_000 }),
        vendorRef: market.vendorRef,
        windowStartMs: market.windowStartMs,
        nowMs: WINDOW_START + 10_000,
      }),
    ).toBeNull();
  });

  it("requires EMA-50 to be evaluated through the prior 5m close", () => {
    const tracker = createFiveMinuteEmaTracker();
    for (let i = 50; i >= 1; i -= 1) {
      tracker.append(bar(WINDOW_START - i * 5 * 60_000));
    }
    expect(emaReadyForWindow({ tracker, windowStartMs: WINDOW_START })).not.toBe(
      null,
    );
    tracker.append(bar(WINDOW_START));
    expect(emaReadyForWindow({ tracker, windowStartMs: WINDOW_START })).toBeNull();
  });

  it("requires the exact settlement bar for the window", () => {
    expect(
      exactSettlementBar({
        bar: bar(WINDOW_START),
        windowStartMs: WINDOW_START,
      }),
    ).not.toBeNull();
    expect(
      exactSettlementBar({
        bar: bar(WINDOW_START - 5 * 60_000),
        windowStartMs: WINDOW_START,
      }),
    ).toBeNull();
  });
});
