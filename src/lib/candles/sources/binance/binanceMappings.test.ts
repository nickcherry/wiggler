import { binanceInterval } from "@alea/lib/candles/sources/binance/binanceInterval";
import { binancePerpSymbol } from "@alea/lib/candles/sources/binance/binancePerpSymbol";
import { binanceSymbol } from "@alea/lib/candles/sources/binance/binanceSymbol";
import { describe, expect, it } from "bun:test";

describe("Binance candle mappings", () => {
  it("maps alea timeframes to Binance intervals", () => {
    expect(binanceInterval({ timeframe: "1m" })).toBe("1m");
    expect(binanceInterval({ timeframe: "5m" })).toBe("5m");
  });

  it("maps assets to spot and perp USDT symbols", () => {
    expect(binanceSymbol({ asset: "btc" })).toBe("BTCUSDT");
    expect(binancePerpSymbol({ asset: "doge" })).toBe("DOGEUSDT");
  });
});
