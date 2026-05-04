import { parseOkxBboFrame } from "@alea/lib/exchangePrices/sources/okx/parseOkxBboFrame";
import { describe, expect, it } from "bun:test";

describe("parseOkxBboFrame", () => {
  it("parses a matching bbo-tbt frame into a quote tick", () => {
    const before = Date.now();
    const tick = parseOkxBboFrame({
      raw: JSON.stringify({
        arg: { channel: "bbo-tbt", instId: "BTC-USDT" },
        data: [{ bids: [["100", "1"]], asks: [["101", "2"]], ts: "12345" }],
      }),
      instId: "BTC-USDT",
      exchange: "okx-spot",
    });
    const after = Date.now();

    expect(tick).toMatchObject({
      exchange: "okx-spot",
      tsExchangeMs: 12_345,
      bid: 100,
      ask: 101,
      mid: 100.5,
    });
    expect(tick?.tsReceivedMs).toBeGreaterThanOrEqual(before);
    expect(tick?.tsReceivedMs).toBeLessThanOrEqual(after);
  });

  it("returns null for unrelated channels, instruments, or invalid prices", () => {
    expect(
      parseOkxBboFrame({
        raw: JSON.stringify({
          arg: { channel: "books", instId: "BTC-USDT" },
          data: [{ bids: [["100"]], asks: [["101"]] }],
        }),
        instId: "BTC-USDT",
        exchange: "okx-spot",
      }),
    ).toBeNull();

    expect(
      parseOkxBboFrame({
        raw: JSON.stringify({
          arg: { channel: "bbo-tbt", instId: "ETH-USDT" },
          data: [{ bids: [["100"]], asks: [["101"]] }],
        }),
        instId: "BTC-USDT",
        exchange: "okx-spot",
      }),
    ).toBeNull();

    expect(
      parseOkxBboFrame({
        raw: JSON.stringify({
          arg: { channel: "bbo-tbt", instId: "BTC-USDT" },
          data: [{ bids: [["bad"]], asks: [["101"]] }],
        }),
        instId: "BTC-USDT",
        exchange: "okx-spot",
      }),
    ).toBeNull();
  });
});
