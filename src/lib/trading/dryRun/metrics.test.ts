import {
  applyTradeToSimulatedOrder,
  createSimulatedDryOrder,
} from "@alea/lib/trading/dryRun/fillSimulation";
import {
  computeDryAggregateMetrics,
  type DryOrderResolution,
} from "@alea/lib/trading/dryRun/metrics";
import { describe, expect, it } from "bun:test";

const base = {
  asset: "btc" as const,
  windowStartMs: 1_777_900_000_000,
  windowEndMs: 1_777_900_300_000,
  vendorRef: "condition",
  expiresAtMs: 1_777_900_250_000,
};

describe("computeDryAggregateMetrics", () => {
  it("reports canonical, touch, all-filled, and unfilled counterfactual PnL", () => {
    const filledWinner = createSimulatedDryOrder({
      ...base,
      id: "winner",
      outcomeRef: "UP",
      side: "up",
      limitPrice: 0.4,
      sharesIfFilled: 10,
      placedAtMs: 1_777_900_100_000,
      queueAheadShares: 0,
    });
    applyTradeToSimulatedOrder({
      order: filledWinner,
      trade: {
        kind: "trade",
        vendorRef: "condition",
        outcomeRef: "UP",
        price: 0.4,
        size: 10,
        side: "SELL",
        atMs: 1_777_900_101_000,
      },
    });
    const unfilledLoser = createSimulatedDryOrder({
      ...base,
      id: "loser",
      outcomeRef: "DOWN",
      side: "down",
      limitPrice: 0.2,
      sharesIfFilled: 10,
      placedAtMs: 1_777_900_110_000,
      queueAheadShares: null,
    });
    applyTradeToSimulatedOrder({
      order: unfilledLoser,
      trade: {
        kind: "trade",
        vendorRef: "condition",
        outcomeRef: "DOWN",
        price: 0.2,
        size: 100,
        side: "SELL",
        atMs: 1_777_900_111_000,
      },
    });
    const resolutions: DryOrderResolution[] = [
      {
        order: filledWinner,
        officialWinningSide: "up",
        proxyWinningSide: "up",
      },
      {
        order: unfilledLoser,
        officialWinningSide: "up",
        proxyWinningSide: "down",
      },
    ];

    const metrics = computeDryAggregateMetrics({ resolutions });

    expect(metrics.orderCount).toBe(2);
    expect(metrics.officialProxyDisagreementCount).toBe(1);
    expect(metrics.canonical).toMatchObject({
      orderCount: 2,
      filledCount: 1,
      fillRate: 0.5,
      winRate: 1,
      pnlUsd: 6,
      meanFillLatencyMs: 1_000,
      medianFillLatencyMs: 1_000,
      p90FillLatencyMs: 1_000,
    });
    expect(metrics.touch).toMatchObject({
      filledCount: 2,
      winRate: 0.5,
      pnlUsd: 4,
    });
    expect(metrics.allOrdersFilled).toMatchObject({
      filledCount: 2,
      winRate: 0.5,
      pnlUsd: 4,
    });
    expect(metrics.unfilledCounterfactual).toMatchObject({
      orderCount: 1,
      filledCount: 1,
      winRate: 0,
      pnlUsd: -2,
    });
  });
});
