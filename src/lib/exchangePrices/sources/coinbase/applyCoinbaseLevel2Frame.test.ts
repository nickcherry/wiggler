import {
  applyCoinbaseLevel2Frame,
  createCoinbaseLevel2State,
} from "@alea/lib/exchangePrices/sources/coinbase/applyCoinbaseLevel2Frame";
import { describe, expect, it } from "bun:test";

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
  it("emits when the best bid/ask is established", () => {
    const state = createCoinbaseLevel2State();

    const tick = applyCoinbaseLevel2Frame({
      raw: frame({
        updates: [
          { side: "bid", price_level: "100", new_quantity: "2" },
          { side: "offer", price_level: "102", new_quantity: "3" },
        ],
      }),
      productId: "BTC-USD",
      exchange: "coinbase-spot",
      state,
    });

    expect(tick).toMatchObject({
      exchange: "coinbase-spot",
      tsExchangeMs: Date.parse("2026-05-04T12:00:00.000Z"),
      bid: 100,
      ask: 102,
      mid: 101,
    });
  });

  it("absorbs deeper-book updates without emitting a top-of-book tick", () => {
    const state = createCoinbaseLevel2State();
    applyCoinbaseLevel2Frame({
      raw: frame({
        updates: [
          { side: "bid", price_level: "100", new_quantity: "2" },
          { side: "offer", price_level: "102", new_quantity: "3" },
        ],
      }),
      productId: "BTC-USD",
      exchange: "coinbase-spot",
      state,
    });

    expect(
      applyCoinbaseLevel2Frame({
        raw: frame({
          updates: [{ side: "bid", price_level: "99", new_quantity: "5" }],
        }),
        productId: "BTC-USD",
        exchange: "coinbase-spot",
        state,
      }),
    ).toBeNull();
  });

  it("emits on top quantity changes and recomputes top when the best level is removed", () => {
    const state = createCoinbaseLevel2State();
    applyCoinbaseLevel2Frame({
      raw: frame({
        updates: [
          { side: "bid", price_level: "100", new_quantity: "2" },
          { side: "bid", price_level: "99", new_quantity: "5" },
          { side: "offer", price_level: "102", new_quantity: "3" },
        ],
      }),
      productId: "BTC-USD",
      exchange: "coinbase-spot",
      state,
    });

    const quantityTick = applyCoinbaseLevel2Frame({
      raw: frame({
        updates: [{ side: "bid", price_level: "100", new_quantity: "4" }],
      }),
      productId: "BTC-USD",
      exchange: "coinbase-spot",
      state,
    });
    expect(quantityTick?.bid).toBe(100);

    const removalTick = applyCoinbaseLevel2Frame({
      raw: frame({
        updates: [{ side: "bid", price_level: "100", new_quantity: "0" }],
      }),
      productId: "BTC-USD",
      exchange: "coinbase-spot",
      state,
    });
    expect(removalTick).toMatchObject({
      bid: 99,
      ask: 102,
      mid: 100.5,
    });
  });

  it("ignores unrelated channels and products", () => {
    const state = createCoinbaseLevel2State();

    expect(
      applyCoinbaseLevel2Frame({
        raw: JSON.stringify({ channel: "heartbeats", events: [] }),
        productId: "BTC-USD",
        exchange: "coinbase-spot",
        state,
      }),
    ).toBeNull();

    expect(
      applyCoinbaseLevel2Frame({
        raw: frame({
          productId: "ETH-USD",
          updates: [
            { side: "bid", price_level: "100", new_quantity: "2" },
            { side: "offer", price_level: "102", new_quantity: "3" },
          ],
        }),
        productId: "BTC-USD",
        exchange: "coinbase-spot",
        state,
      }),
    ).toBeNull();
    expect(state.bestBid).toBeNull();
    expect(state.bestAsk).toBeNull();
  });
});
