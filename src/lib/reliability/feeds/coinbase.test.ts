import {
  createCoinbaseProductStates,
  parseCoinbaseLevel2Frame,
} from "@alea/lib/reliability/feeds/coinbase";
import { describe, expect, it } from "bun:test";

describe("parseCoinbaseLevel2Frame", () => {
  it("maintains top-of-book state per product", () => {
    const states = createCoinbaseProductStates({
      assets: ["btc"],
      productIdForAsset: ({ asset }) => `${asset.toUpperCase()}-USD`,
    });

    const ticks = parseCoinbaseLevel2Frame({
      raw: JSON.stringify({
        channel: "l2_data",
        timestamp: "2026-05-04T13:00:00.000Z",
        events: [
          {
            product_id: "BTC-USD",
            updates: [
              { side: "bid", price_level: "100", new_quantity: "1" },
              { side: "offer", price_level: "101", new_quantity: "2" },
            ],
          },
        ],
      }),
      source: "coinbase-spot",
      productStates: states,
      receivedAtMs: 2_000,
    });

    expect(ticks).toHaveLength(1);
    expect(ticks[0]?.asset).toBe("btc");
    expect(ticks[0]?.price).toBe(100.5);
    expect(ticks[0]?.exchangeTimeMs).toBe(
      Date.parse("2026-05-04T13:00:00.000Z"),
    );
  });
});
