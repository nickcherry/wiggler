import { parseBybitOrderbookFrame } from "@alea/lib/exchangePrices/sources/bybit/parseBybitOrderbookFrame";
import { describe, expect, it } from "bun:test";

describe("parseBybitOrderbookFrame", () => {
  it("updates bid/ask state across frames and emits once both sides exist", () => {
    const state = { bid: null, ask: null };

    expect(
      parseBybitOrderbookFrame({
        raw: JSON.stringify({
          topic: "orderbook.1.BTCUSDT",
          ts: 111,
          data: { b: [["100", "2"]] },
        }),
        topic: "orderbook.1.BTCUSDT",
        exchange: "bybit-spot",
        state,
      }),
    ).toBeNull();

    const before = Date.now();
    const tick = parseBybitOrderbookFrame({
      raw: JSON.stringify({
        topic: "orderbook.1.BTCUSDT",
        ts: 222,
        data: { a: [["102", "3"]] },
      }),
      topic: "orderbook.1.BTCUSDT",
      exchange: "bybit-spot",
      state,
    });
    const after = Date.now();

    expect(tick).toMatchObject({
      exchange: "bybit-spot",
      tsExchangeMs: 222,
      bid: 100,
      ask: 102,
      mid: 101,
    });
    expect(tick?.tsReceivedMs).toBeGreaterThanOrEqual(before);
    expect(tick?.tsReceivedMs).toBeLessThanOrEqual(after);
  });

  it("ignores wrong topics and invalid top levels", () => {
    const state = { bid: null, ask: null };

    expect(
      parseBybitOrderbookFrame({
        raw: JSON.stringify({
          topic: "orderbook.1.ETHUSDT",
          data: { b: [["100", "1"]], a: [["101", "1"]] },
        }),
        topic: "orderbook.1.BTCUSDT",
        exchange: "bybit-spot",
        state,
      }),
    ).toBeNull();

    expect(
      parseBybitOrderbookFrame({
        raw: JSON.stringify({
          topic: "orderbook.1.BTCUSDT",
          data: { b: [["nope", "1"]], a: [["101", "0"]] },
        }),
        topic: "orderbook.1.BTCUSDT",
        exchange: "bybit-spot",
        state,
      }),
    ).toBeNull();
    expect(state).toEqual({ bid: null, ask: null });
  });
});
