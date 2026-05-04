import { coinbaseGranularity } from "@alea/lib/candles/sources/coinbase/coinbaseGranularity";
import { coinbasePerpProductId } from "@alea/lib/candles/sources/coinbase/coinbasePerpProductId";
import { coinbaseProductId } from "@alea/lib/candles/sources/coinbase/coinbaseProductId";
import { describe, expect, it } from "bun:test";

describe("Coinbase candle mappings", () => {
  it("maps alea timeframes to Coinbase granularities", () => {
    expect(coinbaseGranularity({ timeframe: "1m" })).toBe("ONE_MINUTE");
    expect(coinbaseGranularity({ timeframe: "5m" })).toBe("FIVE_MINUTE");
  });

  it("maps assets to spot and perp product ids", () => {
    expect(coinbaseProductId({ asset: "eth" })).toBe("ETH-USD");
    expect(coinbasePerpProductId({ asset: "sol" })).toBe("SOL-PERP-INTX");
  });
});
