import { polymarket } from "@alea/constants/polymarket";
import { discoverPolymarketMarket } from "@alea/lib/trading/vendor/polymarket/discoverMarket";
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

describe("discoverPolymarketMarket", () => {
  it("maps a real-shaped gamma event into a tradable up/down market", async () => {
    const seenUrls: string[] = [];
    installFetch((input) => {
      seenUrls.push(inputUrl(input));
      return Response.json([
        {
          id: "444602",
          slug: "btc-updown-5m-1777900200",
          title: "Bitcoin Up or Down - May 4, 9:10AM-9:15AM ET",
          negRisk: false,
          markets: [
            {
              id: "2148175",
              conditionId:
                "0x652158e35c5f50667ff149bf5471d5038f5e040d614a767932d36a91c79ff93d",
              outcomes: '["Up", "Down"]',
              clobTokenIds:
                '["5801340007174815498835414841079597459241617095676924744437389305626850108250", "3946591208505608706019758568501997836436106430093787902542840825353457738766"]',
              acceptingOrders: true,
              negRisk: false,
            },
          ],
        },
      ]);
    });

    const result = await discoverPolymarketMarket({
      asset: "btc",
      windowStartUnixSeconds: 1_777_900_200,
    });

    expect(seenUrls).toEqual([
      `${polymarket.gammaApiUrl}/events?slug=btc-updown-5m-1777900200`,
    ]);
    expect(result).toEqual({
      negRisk: false,
      market: {
        asset: "btc",
        windowStartUnixSeconds: 1_777_900_200,
        windowStartMs: 1_777_900_200_000,
        windowEndMs: 1_777_900_500_000,
        vendorRef:
          "0x652158e35c5f50667ff149bf5471d5038f5e040d614a767932d36a91c79ff93d",
        upRef:
          "5801340007174815498835414841079597459241617095676924744437389305626850108250",
        downRef:
          "3946591208505608706019758568501997836436106430093787902542840825353457738766",
        acceptingOrders: true,
        displayLabel: "btc-updown-5m-1777900200",
      },
    });
  });

  it("returns null for malformed or non-up/down market payloads", async () => {
    installFetch(() =>
      Response.json([
        {
          slug: "btc-updown-5m-1777900200",
          markets: [
            {
              conditionId: "condition",
              outcomes: '["Down", "Up"]',
              clobTokenIds: '["DOWN", "UP"]',
            },
          ],
        },
      ]),
    );

    expect(
      await discoverPolymarketMarket({
        asset: "btc",
        windowStartUnixSeconds: 1_777_900_200,
      }),
    ).toBeNull();
  });

  it("throws on gamma HTTP failures", async () => {
    installFetch(() => new Response("rate limited", { status: 429 }));

    expect(
      discoverPolymarketMarket({
        asset: "btc",
        windowStartUnixSeconds: 1_777_900_200,
      }),
    ).rejects.toThrow(/429 rate limited/);
  });
});
