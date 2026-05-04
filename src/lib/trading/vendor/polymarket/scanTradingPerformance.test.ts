import {
  scanPolymarketTradingPerformance,
  type TradingPerformanceScanProgress,
} from "@alea/lib/trading/vendor/polymarket/scanTradingPerformance";
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

describe("scanPolymarketTradingPerformance", () => {
  it("fetches paginated trades, resolves markets, and returns dashboard payload data", async () => {
    const progress: TradingPerformanceScanProgress[] = [];
    const payload = await scanPolymarketTradingPerformance({
      walletAddress: "0xwallet",
      generatedAtMs: 1_777_900_600_000,
      client: clientWith({
        pages: [
          {
            next_cursor: "NEXT",
            trades: [
              {
                id: "trade-1",
                market: "condition-1",
                asset_id: "UP_TOKEN",
                side: "BUY",
                size: "10",
                price: "0.4",
                fee_rate_bps: "100",
                match_time: "1777900220",
                outcome: "Up",
                transaction_hash: "0xhash",
                trader_side: "TAKER",
              },
            ],
          },
          {
            next_cursor: "LTE=",
            trades: [],
          },
        ],
        markets: new Map<string, unknown>([
          [
            "condition-1",
            {
              condition_id: "condition-1",
              question: "Bitcoin Up or Down - May 4, 12:00PM ET",
              market_slug: "btc-updown-5m-1777900200",
              end_date_iso: "2026-05-04T16:05:00.000Z",
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

    expect(payload.summary.tradeCount).toBe(1);
    expect(payload.summary.lifetimePnlUsd).toBeCloseTo(5.976, 9);
    expect(payload.trades[0]).toMatchObject({
      id: "trade-1",
      symbol: "BTC",
      result: "win",
      feeUsd: 0.024,
      pnlUsd: 5.976,
    });
    expect(payload.chart).toHaveLength(1);
    expect(progress).toEqual([
      { kind: "trades-page", tradesSoFar: 1 },
      { kind: "markets-progress", resolved: 1, total: 1 },
    ]);
  });
});
