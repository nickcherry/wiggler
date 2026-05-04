import { formatDryWindowSummary } from "@alea/lib/trading/dryRun/formatDryWindowSummary";
import type { DryAggregateMetrics } from "@alea/lib/trading/dryRun/metrics";
import { describe, expect, it } from "bun:test";

describe("formatDryWindowSummary", () => {
  it("renders per-window dry outcomes and session-to-date totals", () => {
    const metrics = aggregateMetrics({
      orderCount: 2,
      disagreementCount: 1,
      canonical: {
        filledCount: 1,
        fillRate: 0.5,
        winRate: 1,
        pnlUsd: 12.79,
        latencyMs: 8_200,
      },
      touch: {
        filledCount: 2,
        fillRate: 1,
        winRate: 0.5,
        pnlUsd: -7.21,
        latencyMs: 3_000,
      },
      allOrdersFilled: {
        filledCount: 2,
        fillRate: 1,
        winRate: 0.5,
        pnlUsd: -7.21,
        latencyMs: 0,
      },
      unfilledCounterfactual: {
        orderCount: 1,
        filledCount: 1,
        fillRate: 1,
        winRate: 0,
        pnlUsd: -20,
        latencyMs: 0,
      },
    });

    const text = formatDryWindowSummary({
      assets: ["btc", "eth", "sol"],
      orders: [
        {
          asset: "btc",
          side: "up",
          limitPrice: 0.61,
          sharesIfFilled: 32.786,
          placedAtMs: 1_000,
          canonicalFilledShares: 32.786,
          canonicalFirstFillAtMs: 9_200,
          touchFilledAtMs: 9_200,
          officialWinningSide: "up",
          proxyWinningSide: "up",
        },
        {
          asset: "eth",
          side: "down",
          limitPrice: 0.4,
          sharesIfFilled: 50,
          placedAtMs: 1_000,
          canonicalFilledShares: 0,
          canonicalFirstFillAtMs: null,
          touchFilledAtMs: null,
          officialWinningSide: "up",
          proxyWinningSide: "down",
        },
      ],
      windowMetrics: metrics,
      sessionMetrics: metrics,
    });

    expect(text).toBe(
      [
        "BTC: ↑ @ $0.61 → filled 32.79/32.79 in 8.2s, won +$12.79",
        "ETH: ↓ @ $0.40 → didn't fill; would have lost -$20.00 if filled (official=↑, proxy=↓)",
        "SOL: no dry order",
        "",
        "Latest Window Dry Pnl: +$12.79",
        "Canonical fills: 1/2 (50.0%); win=100.0%; latency mean/median/p90=8.2s/8.2s/8.2s",
        "Touch Pnl: -$7.21 (2/2 (100.0%))",
        "All-Orders-Filled Pnl: -$7.21 (win=50.0%)",
        "Unfilled Counterfactual Pnl: -$20.00 (win=0.0%)",
        "Official/proxy disagreements: 1",
        "",
        "Session Dry Pnl: +$12.79",
        "Session fills: 1/2 (50.0%); win=100.0%; latency mean/median/p90=8.2s/8.2s/8.2s",
        "Session All-Orders-Filled Pnl: -$7.21 (win=50.0%)",
        "Session official/proxy disagreements: 1",
      ].join("\n"),
    );
  });

  it("handles windows with no dry orders", () => {
    expect(
      formatDryWindowSummary({
        orders: [],
        windowMetrics: aggregateMetrics({ orderCount: 0 }),
        sessionMetrics: aggregateMetrics({ orderCount: 0 }),
      }),
    ).toContain("No dry-run orders entered this market.");
  });
});

function aggregateMetrics({
  orderCount,
  disagreementCount = 0,
  canonical,
  touch,
  allOrdersFilled,
  unfilledCounterfactual,
}: {
  readonly orderCount: number;
  readonly disagreementCount?: number;
  readonly canonical?: FillMetricSeed;
  readonly touch?: FillMetricSeed;
  readonly allOrdersFilled?: FillMetricSeed;
  readonly unfilledCounterfactual?: FillMetricSeed;
}): DryAggregateMetrics {
  return {
    orderCount,
    officialProxyDisagreementCount: disagreementCount,
    canonical: fillMetrics({ orderCount, seed: canonical }),
    touch: fillMetrics({ orderCount, seed: touch }),
    allOrdersFilled: fillMetrics({ orderCount, seed: allOrdersFilled }),
    unfilledCounterfactual: fillMetrics({
      orderCount,
      seed: unfilledCounterfactual,
    }),
  };
}

type FillMetricSeed = {
  readonly orderCount?: number;
  readonly filledCount: number;
  readonly fillRate: number | null;
  readonly winRate: number | null;
  readonly pnlUsd: number;
  readonly latencyMs: number | null;
};

function fillMetrics({
  orderCount,
  seed,
}: {
  readonly orderCount: number;
  readonly seed: FillMetricSeed | undefined;
}): DryAggregateMetrics["canonical"] {
  const filledCount = seed?.filledCount ?? 0;
  const latencyMs = seed?.latencyMs ?? null;
  return {
    orderCount: seed?.orderCount ?? orderCount,
    filledCount,
    fillRate: seed?.fillRate ?? (orderCount === 0 ? null : 0),
    winRate: seed?.winRate ?? null,
    pnlUsd: seed?.pnlUsd ?? 0,
    meanFillLatencyMs: latencyMs,
    medianFillLatencyMs: latencyMs,
    p90FillLatencyMs: latencyMs,
  };
}
