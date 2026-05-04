import type { DryAggregateMetrics } from "@alea/lib/trading/dryRun/metrics";
import { computeDryPnlUsd } from "@alea/lib/trading/dryRun/metrics";
import type { LeadingSide } from "@alea/lib/trading/types";
import type { Asset } from "@alea/types/assets";

export type DryWindowSummaryOrder = {
  readonly asset: Asset;
  readonly side: LeadingSide;
  readonly limitPrice: number;
  readonly sharesIfFilled: number;
  readonly placedAtMs: number;
  readonly canonicalFilledShares: number;
  readonly canonicalFirstFillAtMs: number | null;
  readonly touchFilledAtMs: number | null;
  readonly officialWinningSide: LeadingSide;
  readonly proxyWinningSide: LeadingSide | null;
};

/**
 * End-of-window dry-run message for both Telegram and the console. The
 * "Latest Window" block is the just-closed market; the "Session" block
 * is the running dry-run process total, not lifetime venue PnL.
 */
export function formatDryWindowSummary({
  assets,
  orders,
  windowMetrics,
  sessionMetrics,
}: {
  readonly assets?: readonly Asset[];
  readonly orders: readonly DryWindowSummaryOrder[];
  readonly windowMetrics: DryAggregateMetrics;
  readonly sessionMetrics: DryAggregateMetrics;
}): string {
  const lines: string[] = [];
  if (orders.length === 0) {
    lines.push("No dry-run orders entered this market.");
  } else {
    const orderedAssets = assets ?? orders.map((order) => order.asset);
    const ordersByAsset = new Map(orders.map((order) => [order.asset, order]));
    const emitted = new Set<Asset>();
    for (const asset of orderedAssets) {
      const order = ordersByAsset.get(asset);
      emitted.add(asset);
      lines.push(
        order === undefined
          ? `${asset.toUpperCase()}: no dry order`
          : formatOrderLine({ order }),
      );
    }
    for (const order of orders) {
      if (!emitted.has(order.asset)) {
        lines.push(formatOrderLine({ order }));
      }
    }
  }

  lines.push("");
  lines.push(
    `Latest Window Dry Pnl: ${formatSignedUsd({ value: windowMetrics.canonical.pnlUsd })}`,
  );
  lines.push(
    formatFillLine({
      label: "Canonical fills",
      metrics: windowMetrics.canonical,
    }),
  );
  lines.push(
    `Touch Pnl: ${formatSignedUsd({ value: windowMetrics.touch.pnlUsd })} (${formatCountRate(
      {
        numerator: windowMetrics.touch.filledCount,
        denominator: windowMetrics.touch.orderCount,
        rate: windowMetrics.touch.fillRate,
      },
    )})`,
  );
  lines.push(
    `All-Orders-Filled Pnl: ${formatSignedUsd({ value: windowMetrics.allOrdersFilled.pnlUsd })} (${formatWinRate(
      {
        value: windowMetrics.allOrdersFilled.winRate,
      },
    )})`,
  );
  lines.push(
    `Unfilled Counterfactual Pnl: ${formatSignedUsd({ value: windowMetrics.unfilledCounterfactual.pnlUsd })} (${formatWinRate(
      {
        value: windowMetrics.unfilledCounterfactual.winRate,
      },
    )})`,
  );
  if (windowMetrics.officialProxyDisagreementCount > 0) {
    lines.push(
      `Official/proxy disagreements: ${windowMetrics.officialProxyDisagreementCount}`,
    );
  }

  lines.push("");
  lines.push(
    `Session Dry Pnl: ${formatSignedUsd({ value: sessionMetrics.canonical.pnlUsd })}`,
  );
  lines.push(
    formatFillLine({
      label: "Session fills",
      metrics: sessionMetrics.canonical,
    }),
  );
  lines.push(
    `Session All-Orders-Filled Pnl: ${formatSignedUsd({ value: sessionMetrics.allOrdersFilled.pnlUsd })} (${formatWinRate(
      {
        value: sessionMetrics.allOrdersFilled.winRate,
      },
    )})`,
  );
  if (sessionMetrics.officialProxyDisagreementCount > 0) {
    lines.push(
      `Session official/proxy disagreements: ${sessionMetrics.officialProxyDisagreementCount}`,
    );
  }
  return lines.join("\n");
}

function formatOrderLine({
  order,
}: {
  readonly order: DryWindowSummaryOrder;
}): string {
  const tag = `${order.asset.toUpperCase()}:`;
  const won = order.side === order.officialWinningSide;
  const allFilledPnlUsd = computeDryPnlUsd({
    shares: order.sharesIfFilled,
    price: order.limitPrice,
    won,
  });
  const proxyLabel = formatProxyLabel({ order });
  if (order.canonicalFilledShares > 0) {
    const pnlUsd = computeDryPnlUsd({
      shares: order.canonicalFilledShares,
      price: order.limitPrice,
      won,
    });
    return `${tag} ${arrowOf({ side: order.side })} @ ${formatLimitPrice({ value: order.limitPrice })} → filled ${formatShares({ value: order.canonicalFilledShares })}/${formatShares({ value: order.sharesIfFilled })} in ${formatLatency({ placedAtMs: order.placedAtMs, filledAtMs: order.canonicalFirstFillAtMs })}, ${won ? "won" : "lost"} ${formatSignedUsd({ value: pnlUsd })}${proxyLabel}`;
  }
  return `${tag} ${arrowOf({ side: order.side })} @ ${formatLimitPrice({ value: order.limitPrice })} → didn't fill; would have ${won ? "won" : "lost"} ${formatSignedUsd({ value: allFilledPnlUsd })} if filled${proxyLabel}`;
}

function formatFillLine({
  label,
  metrics,
}: {
  readonly label: string;
  readonly metrics: DryAggregateMetrics["canonical"];
}): string {
  return `${label}: ${formatCountRate({
    numerator: metrics.filledCount,
    denominator: metrics.orderCount,
    rate: metrics.fillRate,
  })}; ${formatWinRate({ value: metrics.winRate })}; ${formatLatencySummary({ metrics })}`;
}

function formatCountRate({
  numerator,
  denominator,
  rate,
}: {
  readonly numerator: number;
  readonly denominator: number;
  readonly rate: number | null;
}): string {
  if (rate === null) {
    return `${numerator}/${denominator}`;
  }
  return `${numerator}/${denominator} (${formatPercent({ value: rate })})`;
}

function formatWinRate({ value }: { readonly value: number | null }): string {
  if (value === null) {
    return "win=--";
  }
  return `win=${formatPercent({ value })}`;
}

function formatLatencySummary({
  metrics,
}: {
  readonly metrics: DryAggregateMetrics["canonical"];
}): string {
  if (
    metrics.meanFillLatencyMs === null &&
    metrics.medianFillLatencyMs === null &&
    metrics.p90FillLatencyMs === null
  ) {
    return "latency=--";
  }
  return `latency mean/median/p90=${formatDurationMs({
    value: metrics.meanFillLatencyMs,
  })}/${formatDurationMs({
    value: metrics.medianFillLatencyMs,
  })}/${formatDurationMs({ value: metrics.p90FillLatencyMs })}`;
}

function formatLatency({
  placedAtMs,
  filledAtMs,
}: {
  readonly placedAtMs: number;
  readonly filledAtMs: number | null;
}): string {
  if (filledAtMs === null) {
    return "--";
  }
  return formatDurationMs({ value: filledAtMs - placedAtMs });
}

function formatDurationMs({
  value,
}: {
  readonly value: number | null;
}): string {
  if (value === null) {
    return "--";
  }
  if (value < 1_000) {
    return `${Math.round(value)}ms`;
  }
  return `${(Math.round(value / 100) / 10).toFixed(1)}s`;
}

function formatProxyLabel({
  order,
}: {
  readonly order: DryWindowSummaryOrder;
}): string {
  if (order.proxyWinningSide === null) {
    return " (proxy pending)";
  }
  if (order.proxyWinningSide === order.officialWinningSide) {
    return "";
  }
  return ` (official=${arrowOf({ side: order.officialWinningSide })}, proxy=${arrowOf({ side: order.proxyWinningSide })})`;
}

function arrowOf({ side }: { readonly side: LeadingSide }): string {
  return side === "up" ? "↑" : "↓";
}

function formatLimitPrice({ value }: { readonly value: number }): string {
  let str = value.toFixed(3);
  while (str.endsWith("0") && decimalPlaces({ value: str }) > 2) {
    str = str.slice(0, -1);
  }
  return `$${str}`;
}

function decimalPlaces({ value }: { readonly value: string }): number {
  return value.split(".")[1]?.length ?? 0;
}

function formatShares({ value }: { readonly value: number }): string {
  return value.toFixed(2);
}

function formatPercent({ value }: { readonly value: number }): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatSignedUsd({ value }: { readonly value: number }): string {
  if (value === 0) {
    return "$0.00";
  }
  const sign = value > 0 ? "+" : "-";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}
