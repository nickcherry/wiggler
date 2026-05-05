import {
  applyCoinbaseLevel2Frame,
  createCoinbaseLevel2State,
} from "@alea/lib/exchangePrices/sources/coinbase/applyCoinbaseLevel2Frame";
import { describe, expect, it } from "bun:test";

const productIdToAsset = new Map<string, "btc" | "eth">([
  ["BTC-USD", "btc"],
  ["ETH-USD", "eth"],
]);

function frame({
  productId = "BTC-USD",
  updates,
  timestamp = "2026-05-04T12:00:00.000Z",
}: {
  readonly productId?: string;
  readonly updates: ReadonlyArray<{
    readonly side: string;
    readonly price_level: string;
    readonly new_quantity: string;
  }>;
  readonly timestamp?: string;
}): string {
  return JSON.stringify({
    channel: "l2_data",
    timestamp,
    events: [{ type: "update", product_id: productId, updates }],
  });
}

describe("applyCoinbaseLevel2Frame", () => {
  it("emits one tick per product whose top of book is established", () => {
    const state = createCoinbaseLevel2State({ productIdToAsset });

    const ticks = applyCoinbaseLevel2Frame({
      raw: frame({
        updates: [
          { side: "bid", price_level: "100", new_quantity: "2" },
          { side: "offer", price_level: "102", new_quantity: "3" },
        ],
      }),
      exchange: "coinbase-spot",
      state,
    });

    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toMatchObject({
      exchange: "coinbase-spot",
      asset: "btc",
      tsExchangeMs: Date.parse("2026-05-04T12:00:00.000Z"),
      bid: 100,
      ask: 102,
      mid: 101,
    });
  });

  it("absorbs deeper-book updates without emitting a top-of-book tick", () => {
    const state = createCoinbaseLevel2State({ productIdToAsset });
    applyCoinbaseLevel2Frame({
      raw: frame({
        updates: [
          { side: "bid", price_level: "100", new_quantity: "2" },
          { side: "offer", price_level: "102", new_quantity: "3" },
        ],
      }),
      exchange: "coinbase-spot",
      state,
    });

    expect(
      applyCoinbaseLevel2Frame({
        raw: frame({
          updates: [{ side: "bid", price_level: "99", new_quantity: "5" }],
        }),
        exchange: "coinbase-spot",
        state,
      }),
    ).toEqual([]);
  });

  it("emits on top quantity changes and recomputes top when the best level is removed", () => {
    const state = createCoinbaseLevel2State({ productIdToAsset });
    applyCoinbaseLevel2Frame({
      raw: frame({
        updates: [
          { side: "bid", price_level: "100", new_quantity: "2" },
          { side: "bid", price_level: "99", new_quantity: "5" },
          { side: "offer", price_level: "102", new_quantity: "3" },
        ],
      }),
      exchange: "coinbase-spot",
      state,
    });

    const quantityTicks = applyCoinbaseLevel2Frame({
      raw: frame({
        updates: [{ side: "bid", price_level: "100", new_quantity: "4" }],
      }),
      exchange: "coinbase-spot",
      state,
    });
    expect(quantityTicks).toHaveLength(1);
    expect(quantityTicks[0]?.bid).toBe(100);

    const removalTicks = applyCoinbaseLevel2Frame({
      raw: frame({
        updates: [{ side: "bid", price_level: "100", new_quantity: "0" }],
      }),
      exchange: "coinbase-spot",
      state,
    });
    expect(removalTicks).toHaveLength(1);
    expect(removalTicks[0]).toMatchObject({
      bid: 99,
      ask: 102,
      mid: 100.5,
    });
  });

  it("ignores unrelated channels and unknown products", () => {
    const state = createCoinbaseLevel2State({ productIdToAsset });

    expect(
      applyCoinbaseLevel2Frame({
        raw: JSON.stringify({ channel: "heartbeats", events: [] }),
        exchange: "coinbase-spot",
        state,
      }),
    ).toEqual([]);

    // SOL-USD isn't in our productIdToAsset map, so it's silently
    // dropped and never affects either of the products we DO know.
    expect(
      applyCoinbaseLevel2Frame({
        raw: frame({
          productId: "SOL-USD",
          updates: [
            { side: "bid", price_level: "100", new_quantity: "2" },
            { side: "offer", price_level: "102", new_quantity: "3" },
          ],
        }),
        exchange: "coinbase-spot",
        state,
      }),
    ).toEqual([]);
    expect(state.byProductId.get("BTC-USD")?.bestBid).toBeNull();
    expect(state.byProductId.get("ETH-USD")?.bestBid).toBeNull();
  });

  it("routes top-of-book updates per product within a single frame", () => {
    const state = createCoinbaseLevel2State({ productIdToAsset });
    const raw = JSON.stringify({
      channel: "l2_data",
      timestamp: "2026-05-04T12:00:00.000Z",
      events: [
        {
          type: "update",
          product_id: "BTC-USD",
          updates: [
            { side: "bid", price_level: "100", new_quantity: "2" },
            { side: "offer", price_level: "102", new_quantity: "3" },
          ],
        },
        {
          type: "update",
          product_id: "ETH-USD",
          updates: [
            { side: "bid", price_level: "10", new_quantity: "50" },
            { side: "offer", price_level: "11", new_quantity: "60" },
          ],
        },
      ],
    });
    const ticks = applyCoinbaseLevel2Frame({
      raw,
      exchange: "coinbase-spot",
      state,
    });
    expect(ticks.map((tick) => tick.asset)).toEqual(["btc", "eth"]);
    expect(ticks.find((tick) => tick.asset === "btc")?.bid).toBe(100);
    expect(ticks.find((tick) => tick.asset === "eth")?.ask).toBe(11);
  });
});
