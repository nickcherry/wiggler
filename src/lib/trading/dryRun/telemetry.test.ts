import type { LivePriceTick } from "@alea/lib/livePrices/types";
import {
  appendMarketTrade,
  appendPriceTick,
  buildEntryBookTelemetry,
  buildEntryPriceTelemetry,
  buildLeadTimeCounterfactuals,
  buildPreEntryMarketTelemetry,
  buildTakerCounterfactual,
  computePreEntryPriceDelta,
  type DryMarketTradeHistory,
  type DryPriceHistory,
} from "@alea/lib/trading/dryRun/telemetry";
import type {
  MarketDataTradeEvent,
  UpDownBook,
} from "@alea/lib/trading/vendor/types";
import { describe, expect, it } from "bun:test";

const placedAtMs = Date.parse("2026-05-04T12:31:00.000Z");

describe("dry-run telemetry", () => {
  it("snapshots pre-entry price velocity, book context, taker, and lead-time fills", () => {
    const priceHistory: DryPriceHistory = new Map();
    appendPriceTick({
      history: priceHistory,
      tick: tick({ mid: 100, secondsAgo: 30 }),
    });
    appendPriceTick({
      history: priceHistory,
      tick: tick({ mid: 101, secondsAgo: 5 }),
    });
    appendPriceTick({
      history: priceHistory,
      tick: tick({ mid: 102, secondsAgo: 0 }),
    });

    const price = buildEntryPriceTelemetry({
      ticks: priceHistory.get("btc") ?? [],
      placedAtMs,
      line: 100,
    });
    expect(price?.mid).toBe(102);
    expect(price?.side).toBe("up");
    expect(price?.lookbacks.some((entry) => entry.lookbackMs === 5_000)).toBe(
      true,
    );

    const bookTelemetry = buildEntryBookTelemetry({
      book: book(),
      side: "up",
      limitPrice: 0.4,
      queueAheadShares: 12,
      placedAtMs,
    });
    expect(bookTelemetry.chosenBestBid).toBe(0.4);
    expect(bookTelemetry.chosenBestAsk).toBe(0.42);
    expect(bookTelemetry.chosenBidSizeAtLimit).toBe(12);

    const taker = buildTakerCounterfactual({
      book: book(),
      side: "up",
      stakeUsd: 20,
    });
    expect(taker?.askPrice).toBe(0.42);
    expect(taker?.estimatedFeeRateBps).toBe(720);

    const marketHistory: DryMarketTradeHistory = new Map();
    appendMarketTrade({
      history: marketHistory,
      trade: trade({ price: 0.41, secondsFromPlacement: -12 }),
      nowMs: placedAtMs,
    });
    appendMarketTrade({
      history: marketHistory,
      trade: trade({ price: 0.39, secondsFromPlacement: 6 }),
      nowMs: placedAtMs + 6_000,
    });
    const preEntry = buildPreEntryMarketTelemetry({
      trades: marketHistory.get("UP") ?? [],
      placedAtMs,
      limitPrice: 0.4,
    });
    expect(preEntry.tradeCountSeen).toBe(1);
    expect(preEntry.lookbacks[0]?.tradeCount).toBe(1);

    const lead = buildLeadTimeCounterfactuals({
      trades: marketHistory.get("UP") ?? [],
      order: {
        placedAtMs,
        expiresAtMs: placedAtMs + 60_000,
        limitPrice: 0.4,
      },
    });
    expect(lead.find((entry) => entry.leadMs === 10_000)?.firstCrossAtMs).toBe(
      placedAtMs + 6_000,
    );
  });

  describe("computePreEntryPriceDelta", () => {
    const trades = [
      trade({ price: 0.5, secondsFromPlacement: -45 }), // outside window
      trade({ price: 0.42, secondsFromPlacement: -25 }),
      trade({ price: 0.4, secondsFromPlacement: -10 }),
      trade({ price: 0.38, secondsFromPlacement: -1 }),
      trade({ price: 0.6, secondsFromPlacement: 5 }), // post-placement
    ];

    it("returns last - first within the lookback window, ignoring out-of-range trades", () => {
      const delta = computePreEntryPriceDelta({
        trades,
        placedAtMs,
        lookbackMs: 30_000,
      });
      // First in [-30s, 0s) is the -25s trade @0.42; last is -1s @0.38.
      expect(delta).toBeCloseTo(0.38 - 0.42, 9);
    });

    it("returns 0 when only one trade falls in the window (last == first)", () => {
      const delta = computePreEntryPriceDelta({
        trades: trades.filter((t) => t.atMs >= placedAtMs - 1_500),
        placedAtMs,
        lookbackMs: 30_000,
      });
      // Only one pre-placement trade in [-1.5s, 0s) → first == last → 0.
      expect(delta).toBe(0);
    });

    it("returns null when there are no pre-placement trades at all", () => {
      const delta = computePreEntryPriceDelta({
        trades: [trade({ price: 0.5, secondsFromPlacement: 5 })],
        placedAtMs,
        lookbackMs: 30_000,
      });
      expect(delta).toBeNull();
    });

    it("returns positive when chosen-outcome price drifted up", () => {
      const upTrades = [
        trade({ price: 0.3, secondsFromPlacement: -20 }),
        trade({ price: 0.34, secondsFromPlacement: -5 }),
      ];
      const delta = computePreEntryPriceDelta({
        trades: upTrades,
        placedAtMs,
        lookbackMs: 30_000,
      });
      expect(delta).toBeGreaterThan(0);
    });
  });
});

function tick({
  mid,
  secondsAgo,
}: {
  readonly mid: number;
  readonly secondsAgo: number;
}): LivePriceTick {
  return {
    asset: "btc",
    bid: mid - 0.5,
    ask: mid + 0.5,
    mid,
    exchangeTimeMs: placedAtMs - secondsAgo * 1000,
    receivedAtMs: placedAtMs - secondsAgo * 1000,
  };
}

function trade({
  price,
  secondsFromPlacement,
}: {
  readonly price: number;
  readonly secondsFromPlacement: number;
}): MarketDataTradeEvent {
  return {
    kind: "trade",
    vendorRef: "condition",
    outcomeRef: "UP",
    price,
    size: 2,
    side: "SELL",
    atMs: placedAtMs + secondsFromPlacement * 1000,
  };
}

function book(): UpDownBook {
  return {
    market: {
      asset: "btc",
      windowStartUnixSeconds: Math.floor((placedAtMs - 60_000) / 1000),
      windowStartMs: placedAtMs - 60_000,
      windowEndMs: placedAtMs + 240_000,
      vendorRef: "condition",
      upRef: "UP",
      downRef: "DOWN",
      acceptingOrders: true,
      constraints: {
        priceTickSize: 0.01,
        minOrderSize: 1,
        minimumOrderAgeSeconds: 0,
        makerBaseFeeBps: 0,
        takerBaseFeeBps: 720,
        feesTakerOnly: true,
      },
    },
    up: {
      bestBid: 0.4,
      bestAsk: 0.42,
      bidLevels: [{ price: 0.4, size: 12 }],
      askLevels: [{ price: 0.42, size: 20 }],
    },
    down: {
      bestBid: 0.58,
      bestAsk: 0.6,
      bidLevels: [{ price: 0.58, size: 10 }],
      askLevels: [{ price: 0.6, size: 10 }],
    },
    fetchedAtMs: placedAtMs - 50,
  };
}
