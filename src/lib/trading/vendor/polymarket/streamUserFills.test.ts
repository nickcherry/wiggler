import { parsePolymarketUserFillEvents } from "@alea/lib/trading/vendor/polymarket/streamUserFills";
import { describe, expect, it } from "bun:test";

describe("parsePolymarketUserFillEvents", () => {
  it("maps V2 maker_orders frames without top-level fill fields and dedupes repeats", () => {
    const seenFills = new Set<string>();
    const tokenIdToSide = new Map([
      ["UP_TOKEN", "up" as const],
      ["DOWN_TOKEN", "down" as const],
    ]);
    const raw = JSON.stringify({
      event_type: "trade",
      market: "condition",
      id: "trade-1",
      status: "MATCHED",
      match_time: "1777900212",
      maker_orders: [
        { asset_id: "DOWN_TOKEN", matched_amount: "3.5", price: "0.42" },
        { asset_id: "OTHER", matched_amount: "99", price: "0.01" },
      ],
    });

    expect(
      parsePolymarketUserFillEvents({ raw, tokenIdToSide, seenFills }),
    ).toEqual([
      {
        vendorRef: "condition",
        outcomeRef: "DOWN_TOKEN",
        side: "down",
        price: 0.42,
        size: 3.5,
        feeRateBps: 0,
        atMs: 1_777_900_212_000,
      },
    ]);
    expect(
      parsePolymarketUserFillEvents({ raw, tokenIdToSide, seenFills }),
    ).toEqual([]);
  });

  it("falls back to legacy top-level trade fields and ignores non-fill statuses", () => {
    const seenFills = new Set<string>();
    const tokenIdToSide = new Map([["UP_TOKEN", "up" as const]]);

    expect(
      parsePolymarketUserFillEvents({
        raw: JSON.stringify([
          {
            market: "condition",
            id: "failed",
            status: "FAILED",
            asset_id: "UP_TOKEN",
            size: "2",
            price: "0.5",
            fee_rate_bps: "720",
          },
          {
            market: "condition",
            id: "filled",
            status: "CONFIRMED",
            asset_id: "UP_TOKEN",
            size: "2",
            price: "0.5",
            fee_rate_bps: "720",
            trader_side: "TAKER",
            last_update: "1777900213",
          },
        ]),
        tokenIdToSide,
        seenFills,
      }),
    ).toEqual([
      {
        vendorRef: "condition",
        outcomeRef: "UP_TOKEN",
        side: "up",
        price: 0.5,
        size: 2,
        feeRateBps: 720,
        atMs: 1_777_900_213_000,
      },
    ]);
  });
});
