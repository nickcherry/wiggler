import { fetchExactFiveMinuteBar } from "@alea/lib/livePrices/binancePerp/fetchRecentFiveMinuteBars";
import { afterEach, describe, expect, it } from "bun:test";

const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalDateNow;
});

function installFetch(
  handler: (input: Parameters<typeof fetch>[0]) => Response | Promise<Response>,
): void {
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => handler(input),
    { preconnect: originalFetch.preconnect },
  );
}

function inputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

describe("fetchExactFiveMinuteBar", () => {
  it("requests one exact closed 5m bar by open timestamp", async () => {
    const openTimeMs = 1_700_000_100_000;
    const seenUrls: string[] = [];
    Date.now = () => openTimeMs + 10 * 60_000;
    installFetch((input) => {
      seenUrls.push(inputUrl(input));
      return Response.json([
        [
          openTimeMs,
          "100",
          "102",
          "99",
          "101",
          "123.45",
          openTimeMs + 5 * 60_000 - 1,
        ],
      ]);
    });

    expect(
      fetchExactFiveMinuteBar({ asset: "btc", openTimeMs }),
    ).resolves.toEqual({
      asset: "btc",
      openTimeMs,
      closeTimeMs: openTimeMs + 5 * 60_000,
      open: 100,
      high: 102,
      low: 99,
      close: 101,
    });
    expect(seenUrls).toEqual([
      `https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=5m&startTime=${openTimeMs}&endTime=${openTimeMs + 5 * 60_000 - 1}&limit=1`,
    ]);
  });

  it("returns null when Binance does not return the requested closed bar", async () => {
    const openTimeMs = 1_700_000_100_000;
    Date.now = () => openTimeMs + 10 * 60_000;
    installFetch(() =>
      Response.json([
        [
          openTimeMs - 5 * 60_000,
          "100",
          "102",
          "99",
          "101",
          "123.45",
          openTimeMs - 1,
        ],
      ]),
    );

    expect(
      fetchExactFiveMinuteBar({ asset: "btc", openTimeMs }),
    ).resolves.toBeNull();
  });
});
