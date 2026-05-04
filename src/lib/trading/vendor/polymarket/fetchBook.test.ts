import { polymarket } from "@alea/constants/polymarket";
import { fetchPolymarketBook } from "@alea/lib/trading/vendor/polymarket/fetchBook";
import type { TradableMarket } from "@alea/lib/trading/vendor/types";
import { afterEach, describe, expect, it } from "bun:test";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
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

const market: TradableMarket = {
  asset: "btc",
  windowStartUnixSeconds: 1_777_900_200,
  windowStartMs: 1_777_900_200_000,
  windowEndMs: 1_777_900_500_000,
  vendorRef: "condition",
  upRef: "UP_TOKEN",
  downRef: "DOWN_TOKEN",
  acceptingOrders: true,
};

describe("fetchPolymarketBook", () => {
  it("fetches both token books and scans real-shaped levels for top of book", async () => {
    const seenUrls: string[] = [];
    installFetch((input) => {
      const url = inputUrl(input);
      seenUrls.push(url);
      if (url.endsWith("token_id=UP_TOKEN")) {
        return Response.json({
          market: "condition",
          asset_id: "UP_TOKEN",
          timestamp: "1777900279143",
          min_order_size: "5",
          tick_size: "0.01",
          neg_risk: true,
          bids: [
            { price: "0.01", size: "7338.13" },
            { price: "0.51", size: "10" },
            { price: "0.52", size: "0" },
            { price: "bad", size: "100" },
          ],
          asks: [
            { price: "0.99", size: "7501.65" },
            { price: "0.54", size: "119" },
            { price: "0.53", size: "210" },
          ],
        });
      }
      return Response.json({
        market: "condition",
        asset_id: "DOWN_TOKEN",
        timestamp: "1777900279143",
        min_order_size: "5",
        tick_size: "0.01",
        neg_risk: true,
        bids: [],
        asks: [{ price: "0.49", size: "12" }],
      });
    });

    const book = await fetchPolymarketBook({ market });

    expect(seenUrls.sort()).toEqual(
      [
        `${polymarket.clobApiUrl}/book?token_id=DOWN_TOKEN`,
        `${polymarket.clobApiUrl}/book?token_id=UP_TOKEN`,
      ].sort(),
    );
    expect(book).toMatchObject({
      market,
      up: { bestBid: 0.51, bestAsk: 0.53 },
      down: { bestBid: null, bestAsk: 0.49 },
    });
    expect(book.market.constraints as unknown).toEqual({
      priceTickSize: 0.01,
      tickSize: "0.01",
      minOrderSize: 5,
      minimumOrderAgeSeconds: 0,
      makerBaseFeeBps: null,
      takerBaseFeeBps: null,
      feesTakerOnly: null,
      negRisk: true,
      rfqEnabled: null,
      takerOrderDelayEnabled: null,
    });
    expect(book.fetchedAtMs).toBeGreaterThan(0);
  });

  it("throws when a token book request fails", () => {
    installFetch(() => new Response("not found", { status: 404 }));

    expect(fetchPolymarketBook({ market })).rejects.toThrow(/404 not found/);
  });
});
