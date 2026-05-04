import {
  canonicalFillLatencyMs,
  type SimulatedDryOrder,
  touchFillLatencyMs,
} from "@alea/lib/trading/dryRun/fillSimulation";
import type { LeadingSide } from "@alea/lib/trading/types";

export type DryOrderResolution = {
  readonly order: SimulatedDryOrder;
  readonly officialWinningSide: LeadingSide;
  readonly proxyWinningSide: LeadingSide | null;
};

export type DryAggregateMetrics = {
  readonly orderCount: number;
  readonly officialProxyDisagreementCount: number;
  readonly canonical: DryFillMetrics;
  readonly touch: DryFillMetrics;
  readonly allOrdersFilled: DryFillMetrics;
  readonly unfilledCounterfactual: DryFillMetrics;
};

export type DryFillMetrics = {
  readonly orderCount: number;
  readonly filledCount: number;
  readonly fillRate: number | null;
  readonly winRate: number | null;
  readonly pnlUsd: number;
  readonly meanFillLatencyMs: number | null;
  readonly medianFillLatencyMs: number | null;
  readonly p90FillLatencyMs: number | null;
};

export function computeDryAggregateMetrics({
  resolutions,
}: {
  readonly resolutions: readonly DryOrderResolution[];
}): DryAggregateMetrics {
  return {
    orderCount: resolutions.length,
    officialProxyDisagreementCount: resolutions.filter(
      (r) =>
        r.proxyWinningSide !== null &&
        r.proxyWinningSide !== r.officialWinningSide,
    ).length,
    canonical: computeFillMetrics({
      resolutions,
      select: (resolution) => {
        const shares = resolution.order.canonicalFilledShares;
        if (shares <= 0) {
          return null;
        }
        return {
          shares,
          latencyMs: canonicalFillLatencyMs({ order: resolution.order }),
        };
      },
    }),
    touch: computeFillMetrics({
      resolutions,
      select: (resolution) =>
        resolution.order.touchFilledAtMs === null
          ? null
          : {
              shares: resolution.order.sharesIfFilled,
              latencyMs: touchFillLatencyMs({ order: resolution.order }),
            },
    }),
    allOrdersFilled: computeFillMetrics({
      resolutions,
      select: (resolution) => ({
        shares: resolution.order.sharesIfFilled,
        latencyMs: 0,
      }),
    }),
    unfilledCounterfactual: computeFillMetrics({
      resolutions: resolutions.filter(
        (r) => r.order.canonicalFilledShares <= 0,
      ),
      select: (resolution) => ({
        shares: resolution.order.sharesIfFilled,
        latencyMs: 0,
      }),
    }),
  };
}

function computeFillMetrics({
  resolutions,
  select,
}: {
  readonly resolutions: readonly DryOrderResolution[];
  readonly select: (
    resolution: DryOrderResolution,
  ) => { readonly shares: number; readonly latencyMs: number | null } | null;
}): DryFillMetrics {
  let filledCount = 0;
  let wins = 0;
  let pnlUsd = 0;
  const latencies: number[] = [];
  for (const resolution of resolutions) {
    const fill = select(resolution);
    if (fill === null || fill.shares <= 0) {
      continue;
    }
    filledCount += 1;
    if (resolution.order.side === resolution.officialWinningSide) {
      wins += 1;
    }
    pnlUsd += computeDryPnlUsd({
      shares: fill.shares,
      price: resolution.order.limitPrice,
      won: resolution.order.side === resolution.officialWinningSide,
    });
    if (fill.latencyMs !== null) {
      latencies.push(fill.latencyMs);
    }
  }
  return {
    orderCount: resolutions.length,
    filledCount,
    fillRate:
      resolutions.length === 0 ? null : filledCount / resolutions.length,
    winRate: filledCount === 0 ? null : wins / filledCount,
    pnlUsd,
    meanFillLatencyMs: mean(latencies),
    medianFillLatencyMs: percentile({ values: latencies, p: 0.5 }),
    p90FillLatencyMs: percentile({ values: latencies, p: 0.9 }),
  };
}

export function computeDryPnlUsd({
  shares,
  price,
  won,
}: {
  readonly shares: number;
  readonly price: number;
  readonly won: boolean;
}): number {
  const cost = shares * price;
  return (won ? shares : 0) - cost;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function percentile({
  values,
  p,
}: {
  readonly values: readonly number[];
  readonly p: number;
}): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[index] ?? null;
}
