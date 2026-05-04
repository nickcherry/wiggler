import { renderTradingPerformanceHtml } from "@alea/lib/trading/performance/renderTradingPerformanceHtml";
import type { TradingPerformancePayload } from "@alea/lib/trading/performance/types";
import { describe, expect, it } from "bun:test";

describe("renderTradingPerformanceHtml", () => {
  it("renders the Alea shell, PnL chart host, and trade ledger", () => {
    const html = renderTradingPerformanceHtml({
      payload: payloadFixture(),
    });

    expect(html).toContain("Polymarket Trading Performance");
    expect(html).toContain("https://cdn.jsdelivr.net/npm/uplot@1.6.30");
    expect(html).toContain('id="pnl-chart"');
    expect(html).toContain("BTC");
    expect(html).toContain("Bitcoin Up or Down");
    expect(html).toContain("+$69.79");
    expect(html).toContain("Polymarket CLOB API only");
  });
});

function payloadFixture(): TradingPerformancePayload {
  return {
    command: "trading:performance",
    generatedAtMs: 1_777_900_600_000,
    walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
    source: {
      trades: "Polymarket CLOB /data/trades via getTradesPaginated",
      markets: "Polymarket CLOB /markets/{conditionId} via getMarket",
      fees: "fee formula",
    },
    summary: {
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      tradeCount: 1,
      resolvedTradeCount: 1,
      unresolvedTradeCount: 0,
      resolvedMarketCount: 1,
      unresolvedMarketCount: 0,
      winningTradeCount: 1,
      losingTradeCount: 0,
      flatTradeCount: 0,
      lifetimePnlUsd: 69.79,
      resolvedFeesUsd: 0.21,
      totalFeesUsd: 0.21,
      totalVolumeUsd: 30,
      firstTradeAtMs: 1_777_900_220_000,
      lastTradeAtMs: 1_777_900_220_000,
    },
    chart: [
      {
        conditionId: "condition-1",
        symbol: "BTC",
        question: "Bitcoin Up or Down",
        settledAtMs: 1_777_900_500_000,
        marketPnlUsd: 69.79,
        cumulativePnlUsd: 69.79,
      },
    ],
    markets: [
      {
        conditionId: "condition-1",
        symbol: "BTC",
        question: "Bitcoin Up or Down",
        marketSlug: "btc-updown-5m-1777900200",
        endDateMs: 1_777_900_500_000,
        settledAtMs: 1_777_900_500_000,
        resolved: true,
        winningOutcome: "Up",
        tradeCount: 1,
        volumeUsd: 30,
        feesUsd: 0.21,
        pnlUsd: 69.79,
      },
    ],
    trades: [
      {
        id: "trade-1",
        conditionId: "condition-1",
        tokenId: "UP",
        symbol: "BTC",
        question: "Bitcoin Up or Down",
        marketSlug: "btc-updown-5m-1777900200",
        side: "BUY",
        traderSide: "TAKER",
        outcome: "Up",
        size: 100,
        price: 0.3,
        notionalUsd: 30,
        feeRateBps: 100,
        feeUsd: 0.21,
        tradeTimeMs: 1_777_900_220_000,
        resolved: true,
        resolvedPrice: 1,
        pnlUsd: 69.79,
        result: "win",
        transactionHash: "0xhash",
      },
    ],
  };
}
