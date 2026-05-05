import { renderDryRunReportHtml } from "@alea/lib/trading/dryRun/report/renderDryRunReportHtml";
import type { DryRunReportPayload } from "@alea/lib/trading/dryRun/report/types";
import { describe, expect, it } from "bun:test";

describe("renderDryRunReportHtml", () => {
  it("renders the Alea shell and dry-run execution sections", () => {
    const html = renderDryRunReportHtml({
      payload: payloadFixture(),
    });

    expect(html).toContain("Alea");
    expect(html).toContain("Dry Trading Session");
    expect(html).toContain("Filled vs Placed");
    expect(html).toContain("Placement Distribution");
    expect(html).toContain("Filled + unfilled");
    expect(html).toContain("Abs dist to line");
    expect(html).toContain("Polymarket limit");
    expect(html).toContain("Asset Breakdown");
    expect(html).toContain("Unfilled Orders");
    expect(html).toContain("pending excluded");
    expect(html).toContain("DOGE");
  });
});

function payloadFixture(): DryRunReportPayload {
  return {
    generatedAtMs: Date.parse("2026-05-04T12:40:00.000Z"),
    sourcePath: "/tmp/dry-trading_2026.jsonl",
    sessionStartAtMs: Date.parse("2026-05-04T12:30:00.000Z"),
    sessionStopAtMs: null,
    config: {
      vendor: "polymarket",
      priceSource: "binance-perp",
      assets: ["doge"],
      minEdge: 0.05,
      stakeUsd: 20,
      tableRange: "2023-01-01..2026-01-01",
      telegramAlerts: true,
    },
    summary: {
      orderCount: 1,
      finalizedOrderCount: 1,
      pendingOrderCount: 0,
      canonicalFilledCount: 0,
      touchFilledCount: 1,
      canonicalFillRate: 0,
      touchFillRate: 1,
      filledWinRate: null,
      allOrdersWinRate: 1,
      unfilledWouldWinRate: 1,
      canonicalPnlUsd: 0,
      touchPnlUsd: 80,
      takerCounterfactualCount: 0,
      takerCounterfactualWinRate: null,
      takerCounterfactualPnlUsd: 0,
      allOrdersFilledPnlUsd: 80,
      unfilledCounterfactualPnlUsd: 80,
      fillSelectionDeltaUsd: -80,
      meanFillLatencyMs: null,
      medianFillLatencyMs: null,
      p90FillLatencyMs: null,
      officialProxyDisagreementCount: 0,
      unfilledWouldWinCount: 1,
      unfilledWouldLoseCount: 0,
      filledWinCount: 0,
      filledLoseCount: 0,
    },
    byAsset: [
      {
        asset: "doge",
        orderCount: 1,
        finalizedOrderCount: 1,
        pendingOrderCount: 0,
        canonicalFilledCount: 0,
        touchFilledCount: 1,
        canonicalFillRate: 0,
        touchFillRate: 1,
        filledWinRate: null,
        allOrdersWinRate: 1,
        unfilledWouldWinRate: 1,
        canonicalPnlUsd: 0,
        touchPnlUsd: 80,
        takerCounterfactualCount: 0,
        takerCounterfactualWinRate: null,
        takerCounterfactualPnlUsd: 0,
        allOrdersFilledPnlUsd: 80,
        unfilledCounterfactualPnlUsd: 80,
        fillSelectionDeltaUsd: -80,
        meanFillLatencyMs: null,
        medianFillLatencyMs: null,
        p90FillLatencyMs: null,
        officialProxyDisagreementCount: 0,
        unfilledWouldWinCount: 1,
        unfilledWouldLoseCount: 0,
        filledWinCount: 0,
        filledLoseCount: 0,
      },
    ],
    windows: [
      {
        windowStartMs: Date.parse("2026-05-04T12:30:00.000Z"),
        windowEndMs: Date.parse("2026-05-04T12:35:00.000Z"),
        status: "finalized",
        orderCount: 1,
        canonicalFilledCount: 0,
        canonicalPnlUsd: 0,
        touchPnlUsd: 80,
        allOrdersFilledPnlUsd: 80,
        unfilledCounterfactualPnlUsd: 80,
        officialProxyDisagreementCount: 0,
      },
    ],
    orders: [
      {
        id: "dry-order",
        asset: "doge",
        windowStartMs: Date.parse("2026-05-04T12:30:00.000Z"),
        windowEndMs: Date.parse("2026-05-04T12:35:00.000Z"),
        side: "up",
        limitPrice: 0.2,
        sharesIfFilled: 100,
        placedAtMs: Date.parse("2026-05-04T12:31:00.000Z"),
        expiresAtMs: Date.parse("2026-05-04T12:34:50.000Z"),
        queueAheadShares: 5,
        observedAtLimitShares: 0,
        canonicalFilledShares: 0,
        canonicalFirstFillAtMs: null,
        canonicalFullFillAtMs: null,
        touchFilledAtMs: Date.parse("2026-05-04T12:31:02.000Z"),
        entryPrice: 0.11,
        line: 0.1,
        upBestBid: 0.2,
        upBestAsk: 0.22,
        downBestBid: 0.78,
        downBestAsk: 0.8,
        spread: 0.02,
        remaining: 4,
        distanceBp: 9,
        currentSide: "up",
        regime: null,
        decisivelyAway: false,
        ema50: null,
        samples: 1000,
        modelProbability: 0.4,
        edge: 0.2,
        officialOutcome: "up",
        proxyOutcome: "up",
        proxyLine: 0.1,
        proxyClose: 0.11,
        proxyMarginBp: 1000,
        proxyAbsMarginBp: 1000,
        officialResolvedAtMs: Date.parse("2026-05-04T12:35:05.000Z"),
        officialPendingReason: null,
        canonicalPnlUsd: null,
        touchPnlUsd: 80,
        allOrdersFilledPnlUsd: 80,
        unfilledCounterfactualPnlUsd: 80,
        takerCounterfactual: null,
        takerCounterfactualPnlUsd: null,
        entryPriceTelemetry: null,
        entryBookTelemetry: null,
        preEntryMarketTelemetry: null,
        leadTimeCounterfactuals: [],
        canonicalFillLatencyMs: null,
        touchFillLatencyMs: 2_000,
        status: "unfilled",
        wonIfFilled: true,
        officialProxyDisagreed: false,
      },
    ],
    parseErrors: [],
  };
}
