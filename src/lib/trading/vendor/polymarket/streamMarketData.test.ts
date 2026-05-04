import { parsePolymarketMarketDataEvents } from "@alea/lib/trading/vendor/polymarket/streamMarketData";
import { describe, expect, it } from "bun:test";

const tokenIdToSide = new Map([
  ["UP", "up" as const],
  ["DOWN", "down" as const],
]);

describe("parsePolymarketMarketDataEvents", () => {
  it("parses book frames with full depth", () => {
    expect(
      parsePolymarketMarketDataEvents({
        raw: JSON.stringify({
          event_type: "book",
          market: "condition",
          asset_id: "UP",
          timestamp: "1777900200",
          bids: [
            { price: "0.51", size: "10" },
            { price: "bad", size: "5" },
          ],
          asks: [{ price: "0.53", size: "12" }],
        }),
        tokenIdToSide,
      }),
    ).toEqual([
      {
        kind: "book",
        vendorRef: "condition",
        outcomeRef: "UP",
        bids: [{ price: 0.51, size: 10 }],
        asks: [{ price: 0.53, size: 12 }],
        atMs: 1_777_900_200_000,
      },
    ]);
  });

  it("parses price_change changes", () => {
    expect(
      parsePolymarketMarketDataEvents({
        raw: JSON.stringify({
          event_type: "price_change",
          market: "condition",
          timestamp: 1_777_900_201_000,
          changes: [
            { asset_id: "UP", price: "0.52", size: "7", side: "BUY" },
          ],
        }),
        tokenIdToSide,
      }),
    ).toEqual([
      {
        kind: "price-change",
        vendorRef: "condition",
        outcomeRef: "UP",
        price: 0.52,
        side: "BUY",
        size: 7,
        atMs: 1_777_900_201_000,
      },
    ]);
  });

  it("parses last_trade_price frames as trades", () => {
    expect(
      parsePolymarketMarketDataEvents({
        raw: JSON.stringify({
          event_type: "last_trade_price",
          market: "condition",
          asset_id: "DOWN",
          price: "0.41",
          size: "3.5",
          side: "SELL",
          timestamp: 1_777_900_202_000,
        }),
        tokenIdToSide,
      }),
    ).toEqual([
      {
        kind: "trade",
        vendorRef: "condition",
        outcomeRef: "DOWN",
        price: 0.41,
        size: 3.5,
        side: "SELL",
        atMs: 1_777_900_202_000,
      },
    ]);
  });

  it("parses best_bid_ask, tick_size_change, and market_resolved frames", () => {
    const events = parsePolymarketMarketDataEvents({
      raw: JSON.stringify([
        {
          event_type: "best_bid_ask",
          market: "condition",
          asset_id: "UP",
          best_bid: "0.50",
          best_ask: "0.52",
          timestamp: 1_777_900_203_000,
        },
        {
          event_type: "tick_size_change",
          market: "condition",
          asset_id: "UP",
          old_tick_size: "0.01",
          new_tick_size: "0.001",
          timestamp: 1_777_900_204_000,
        },
        {
          event_type: "market_resolved",
          market: "condition",
          asset_id: "DOWN",
          timestamp: 1_777_900_205_000,
        },
      ]),
      tokenIdToSide,
    });

    expect(events).toEqual([
      {
        kind: "best-bid-ask",
        vendorRef: "condition",
        outcomeRef: "UP",
        bestBid: 0.5,
        bestAsk: 0.52,
        atMs: 1_777_900_203_000,
      },
      {
        kind: "tick-size-change",
        vendorRef: "condition",
        outcomeRef: "UP",
        oldTickSize: 0.01,
        newTickSize: 0.001,
        atMs: 1_777_900_204_000,
      },
      {
        kind: "resolved",
        vendorRef: "condition",
        winningOutcomeRef: "DOWN",
        winningSide: "down",
        atMs: 1_777_900_205_000,
      },
    ]);
  });
});
