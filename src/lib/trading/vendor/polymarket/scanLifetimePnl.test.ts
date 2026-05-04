import { scanPolymarketLifetimePnl } from "@alea/lib/trading/vendor/polymarket/scanLifetimePnl";
import type { LifetimePnlScanProgress } from "@alea/lib/trading/vendor/types";
import type { ClobClient } from "@polymarket/clob-client-v2";
import { describe, expect, it } from "bun:test";

function clientWith({
  pages,
  markets,
}: {
  readonly pages: readonly unknown[];
  readonly markets: ReadonlyMap<string, unknown>;
}): ClobClient {
  let pageIndex = 0;
  return {
    async getTradesPaginated(_params: object, cursor?: string) {
      expect(cursor).toBe(pageIndex === 0 ? undefined : "NEXT");
      const page = pages[pageIndex];
      pageIndex += 1;
      return page;
    },
    async getMarket(conditionId: string) {
      return markets.get(conditionId) ?? { tokens: [] };
    },
  } as unknown as ClobClient;
}

describe("scanPolymarketLifetimePnl", () => {
  it("accepts the actual clob-client paginated trades wrapper and computes resolved pnl", async () => {
    const progress: LifetimePnlScanProgress[] = [];
    const result = await scanPolymarketLifetimePnl({
      client: clientWith({
        pages: [
          {
            limit: 500,
            count: 1,
            next_cursor: "NEXT",
            trades: [
              {
                id: "trade-1",
                market: "condition-1",
                asset_id: "UP_TOKEN",
                side: "BUY",
                size: "10",
                price: "0.4",
                fee_rate_bps: "0",
                status: "MATCHED",
              },
            ],
          },
          {
            limit: 500,
            count: 1,
            next_cursor: "LTE=",
            trades: [
              {
                id: "trade-2",
                market: "condition-2",
                asset_id: "DOWN_TOKEN",
                side: "BUY",
                size: "5",
                price: "0.6",
                fee_rate_bps: "0",
                status: "MATCHED",
              },
            ],
          },
        ],
        markets: new Map<string, unknown>([
          [
            "condition-1",
            {
              condition_id: "condition-1",
              closed: true,
              tokens: [
                { token_id: "UP_TOKEN", outcome: "Up", price: 1, winner: true },
                {
                  token_id: "DOWN_TOKEN",
                  outcome: "Down",
                  price: 0,
                  winner: false,
                },
              ],
            },
          ],
          [
            "condition-2",
            {
              condition_id: "condition-2",
              closed: true,
              tokens: [
                { token_id: "UP_TOKEN", outcome: "Up", price: 1, winner: true },
                {
                  token_id: "DOWN_TOKEN",
                  outcome: "Down",
                  price: 0,
                  winner: false,
                },
              ],
            },
          ],
        ]),
      }),
      onProgress: (event) => progress.push(event),
    });

    expect(result).toEqual({
      lifetimePnlUsd: 3,
      resolvedMarketsCounted: 2,
      unresolvedMarketsSkipped: 0,
      tradesCounted: 2,
    });
    expect(progress).toEqual([
      { kind: "trades-page", tradesSoFar: 1 },
      { kind: "trades-page", tradesSoFar: 2 },
      { kind: "markets-progress", resolved: 2, total: 2 },
    ]);
  });

  it("throws on paginated trade payloads without a trades or data array", () => {
    expect(
      scanPolymarketLifetimePnl({
        client: clientWith({
          pages: [{ next_cursor: "LTE=", count: 0 }],
          markets: new Map(),
        }),
      }),
    ).rejects.toThrow(/expected data or trades array/);
  });
});
