import {
  buildTradingPerformancePayload,
  type TradingPerformanceInputMarket,
  type TradingPerformanceInputTrade,
} from "@alea/lib/trading/performance/buildTradingPerformancePayload";
import { describe, expect, it } from "bun:test";

const market: TradingPerformanceInputMarket = {
  conditionId: "condition-1",
  question: "Bitcoin Up or Down - May 4, 12:00PM ET",
  marketSlug: "btc-updown-5m-1777900200",
  endDateMs: 1_777_900_500_000,
  closed: true,
  tokens: [
    { tokenId: "UP", outcome: "Up", price: 1, winner: true },
    { tokenId: "DOWN", outcome: "Down", price: 0, winner: false },
  ],
};

function trade(
  overrides: Partial<TradingPerformanceInputTrade>,
): TradingPerformanceInputTrade {
  return {
    id: "trade-1",
    conditionId: "condition-1",
    tokenId: "UP",
    side: "BUY",
    traderSide: "TAKER",
    size: 100,
    price: 0.3,
    feeRateBps: 100,
    tradeTimeMs: 1_777_900_220_000,
    outcome: "Up",
    transactionHash: "0xhash",
    ...overrides,
  };
}

describe("buildTradingPerformancePayload", () => {
  it("builds trade rows, market rows, and cumulative PnL from Polymarket trades", () => {
    const payload = buildTradingPerformancePayload({
      walletAddress: "0xwallet",
      generatedAtMs: 1_777_900_600_000,
      markets: [market],
      trades: [
        trade({ id: "buy-up" }),
        trade({
          id: "sell-down",
          tokenId: "DOWN",
          side: "SELL",
          size: 50,
          price: 0.4,
          feeRateBps: 0,
          outcome: "Down",
          tradeTimeMs: 1_777_900_230_000,
        }),
      ],
    });

    expect(payload.summary.tradeCount).toBe(2);
    expect(payload.summary.resolvedTradeCount).toBe(2);
    expect(payload.summary.lifetimePnlUsd).toBeCloseTo(89.79, 9);
    expect(payload.summary.resolvedFeesUsd).toBeCloseTo(0.21, 9);
    expect(payload.trades.find((row) => row.id === "buy-up")).toMatchObject({
      symbol: "BTC",
      resolvedPrice: 1,
      result: "win",
    });
    expect(payload.trades.find((row) => row.id === "sell-down")).toMatchObject({
      resolvedPrice: 0,
      pnlUsd: 20,
      result: "win",
    });
    expect(payload.markets).toHaveLength(1);
    const marketPnl = payload.markets[0]?.pnlUsd;
    expect(marketPnl).toBeCloseTo(89.79, 9);
    if (marketPnl === null || marketPnl === undefined) {
      throw new Error("expected resolved market pnl");
    }
    expect(payload.chart).toEqual([
      {
        conditionId: "condition-1",
        symbol: "BTC",
        question: "Bitcoin Up or Down - May 4, 12:00PM ET",
        settledAtMs: 1_777_900_500_000,
        marketPnlUsd: marketPnl,
        cumulativePnlUsd: marketPnl,
      },
    ]);
  });

  it("leaves unresolved trades out of PnL and chart totals", () => {
    const payload = buildTradingPerformancePayload({
      walletAddress: "0xwallet",
      generatedAtMs: 1_777_900_600_000,
      markets: [{ ...market, closed: false }],
      trades: [trade({ id: "open" })],
    });

    expect(payload.summary.lifetimePnlUsd).toBe(0);
    expect(payload.summary.unresolvedTradeCount).toBe(1);
    expect(payload.trades[0]?.result).toBe("open");
    expect(payload.trades[0]?.pnlUsd).toBeNull();
    expect(payload.chart).toEqual([]);
  });

  it("zeros maker fees even when the market fee rate is present", () => {
    const payload = buildTradingPerformancePayload({
      walletAddress: "0xwallet",
      generatedAtMs: 1_777_900_600_000,
      markets: [market],
      trades: [trade({ traderSide: "MAKER", feeRateBps: 720 })],
    });

    expect(payload.trades[0]?.feeUsd).toBe(0);
    expect(payload.summary.lifetimePnlUsd).toBeCloseTo(70, 9);
  });
});
