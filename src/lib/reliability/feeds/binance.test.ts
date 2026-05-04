import {
  buildBinanceSymbolMap,
  parseBinanceBookTickerFrame,
} from "@alea/lib/reliability/feeds/binance";
import { describe, expect, it } from "bun:test";

describe("parseBinanceBookTickerFrame", () => {
  it("parses combined stream bookTicker frames", () => {
    const tick = parseBinanceBookTickerFrame({
      raw: JSON.stringify({
        stream: "btcusdt@bookTicker",
        data: { s: "BTCUSDT", b: "100", a: "101", E: 1_000 },
      }),
      source: "binance-spot",
      symbolToAsset: buildBinanceSymbolMap({
        assets: ["btc"],
        product: "spot",
      }),
      receivedAtMs: 2_000,
    });

    expect(tick).not.toBeNull();
    expect(tick?.asset).toBe("btc");
    expect(tick?.price).toBe(100.5);
    expect(tick?.exchangeTimeMs).toBe(1_000);
  });
});
