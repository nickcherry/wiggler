import {
  buildPolymarketSymbolMap,
  parsePolymarketChainlinkFrame,
} from "@alea/lib/reliability/feeds/polymarket";
import { describe, expect, it } from "bun:test";

describe("parsePolymarketChainlinkFrame", () => {
  it("parses RTDS chainlink updates for requested assets", () => {
    const ticks = parsePolymarketChainlinkFrame({
      raw: JSON.stringify({
        topic: "crypto_prices_chainlink",
        type: "update",
        payload: {
          symbol: "eth/usd",
          value: 2_300.25,
          timestamp: 1_777_902_600_000,
        },
      }),
      symbolToAsset: buildPolymarketSymbolMap({ assets: ["btc", "eth"] }),
      receivedAtMs: 2_000,
    });

    expect(ticks).toHaveLength(1);
    expect(ticks[0]?.asset).toBe("eth");
    expect(ticks[0]?.price).toBe(2_300.25);
  });
});
