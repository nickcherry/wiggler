import type {
  DryRunAssetSummary,
  DryRunReportOrder,
  DryRunReportPayload,
  DryRunReportSummary,
  DryRunWindowSummary,
} from "@alea/lib/trading/dryRun/report/types";
import {
  aleaBrandMark,
  aleaDesignSystemHead,
} from "@alea/lib/ui/aleaDesignSystem";

export function renderDryRunReportHtml({
  payload,
}: {
  readonly payload: DryRunReportPayload;
}): string {
  const finalizedOrders = payload.orders.filter(isFinalized);
  const filledOrders = finalizedOrders.filter(isActuallyFilled);
  const unfilledOrders = finalizedOrders.filter(
    (order) => !isActuallyFilled(order),
  );
  const finalizedAssets = payload.byAsset.filter(
    (asset) => asset.finalizedOrderCount > 0,
  );
  const finalizedWindows = payload.windows.filter(
    (window) => window.status === "finalized",
  );

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Alea &middot; Dry Trading Report</title>
  ${aleaDesignSystemHead()}
  <style>
    .context-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      border: 1px solid var(--alea-border-muted);
      border-radius: 10px;
      overflow: hidden;
      background: linear-gradient(180deg, var(--alea-panel-2), var(--alea-bg-soft));
    }
    .context-item {
      min-width: 0;
      padding: 11px 13px;
      border-right: 1px solid var(--alea-border-faint);
      border-bottom: 1px solid var(--alea-border-faint);
    }
    .context-item:nth-child(4n) { border-right: 0; }
    .context-label {
      margin: 0 0 4px;
      color: var(--alea-text-muted);
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.15em;
      text-transform: uppercase;
    }
    .context-value {
      margin: 0;
      color: var(--alea-text);
      font-size: 12.5px;
      font-variant-numeric: tabular-nums;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .analysis-grid {
      display: grid;
      grid-template-columns: minmax(340px, 0.45fr) minmax(0, 1fr);
      gap: 18px;
      align-items: start;
    }
    .subsection-title {
      margin: 0 0 9px;
      color: var(--alea-text-muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }
    .dense-table {
      font-size: 12.5px;
    }
    .dense-table thead th {
      padding: 10px 11px 9px;
      font-size: 10px;
      letter-spacing: 0.13em;
    }
    .dense-table tbody th,
    .dense-table tbody td {
      padding: 9px 11px;
    }
    .dense-table .group-head {
      text-align: center !important;
      color: var(--alea-text-muted);
      background: rgba(215, 170, 69, 0.055);
      border-left: 1px solid var(--alea-border-faint);
    }
    .comparison-grid {
      display: grid;
      grid-template-columns: minmax(360px, 0.42fr) minmax(0, 1fr);
      gap: 16px;
      align-items: start;
    }
    .note-cell {
      color: var(--alea-text-subtle) !important;
      font-size: 12px;
      max-width: 420px;
    }
    .table-note {
      margin: 10px 0 0;
      color: var(--alea-text-subtle);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      padding: 2px 7px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      border: 1px solid var(--alea-border-muted);
      white-space: nowrap;
      color: var(--alea-text-muted);
      background: rgba(215, 170, 69, 0.035);
    }
    .pill.win {
      color: var(--alea-green);
      border-color: rgba(70, 195, 123, 0.45);
      background: rgba(70, 195, 123, 0.08);
    }
    .pill.loss {
      color: var(--alea-red);
      border-color: rgba(216, 90, 79, 0.5);
      background: rgba(216, 90, 79, 0.09);
    }
    .pill.pending {
      color: var(--alea-gold);
      background: rgba(215, 170, 69, 0.07);
    }
    .num-positive { color: var(--alea-green) !important; }
    .num-negative { color: var(--alea-red) !important; }
    .mono {
      font-family: var(--alea-font-mono);
      font-variant-numeric: tabular-nums;
    }
    .nowrap { white-space: nowrap; }
    .muted { color: var(--alea-text-subtle); }
    .order-id {
      max-width: 145px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .line-pair {
      min-width: 82px;
      color: var(--alea-text-muted);
      line-height: 1.45;
    }
    @media (max-width: 1180px) {
      .context-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .context-item:nth-child(2n) { border-right: 0; }
      .analysis-grid,
      .comparison-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 680px) {
      .context-grid { grid-template-columns: 1fr; }
      .context-item { border-right: 0; }
    }
  </style>
</head>
<body>
  <div class="alea-shell">
    <header class="alea-header">
      <div class="alea-brand-row">${aleaBrandMark()}</div>
      <h1 class="alea-title">Dry Trading Session</h1>
    </header>
    <main class="alea-main">
      ${renderSessionContext({ payload })}
      ${renderExecutionComparisonSection({
        summary: payload.summary,
        orders: finalizedOrders,
      })}
      ${renderActualFilledSection({
        summary: payload.summary,
        orders: filledOrders,
      })}
      ${renderPlacedCounterfactualSection({
        summary: payload.summary,
        orders: finalizedOrders,
        unfilledOrders,
      })}
      ${renderAssetTable({ assets: finalizedAssets })}
      ${renderWindowTable({ windows: finalizedWindows })}
      ${renderParseErrors({ errors: payload.parseErrors })}
    </main>
  </div>
</body>
</html>`;
}

function renderSessionContext({
  payload,
}: {
  readonly payload: DryRunReportPayload;
}): string {
  const config = payload.config;
  return `
    <section class="alea-card with-corners">
      <div class="alea-card-header">
        <h2 class="alea-card-title">Session Context</h2>
      </div>
      <div class="context-grid">
        ${contextItem({ label: "JSONL", value: payload.sourcePath })}
        ${contextItem({
          label: "Generated",
          value: formatDateTime({ ms: payload.generatedAtMs }),
        })}
        ${contextItem({
          label: "Started",
          value:
            payload.sessionStartAtMs === null
              ? "--"
              : formatDateTime({ ms: payload.sessionStartAtMs }),
        })}
        ${contextItem({
          label: "Stopped",
          value:
            payload.sessionStopAtMs === null
              ? "still running or not cleanly stopped"
              : formatDateTime({ ms: payload.sessionStopAtMs }),
        })}
        ${contextItem({
          label: "Orders",
          value: `${payload.summary.finalizedOrderCount} finalized analyzed · ${payload.summary.pendingOrderCount} pending excluded`,
        })}
        ${contextItem({ label: "Venue", value: config?.vendor ?? "--" })}
        ${contextItem({
          label: "Price Source",
          value: config?.priceSource ?? "--",
        })}
        ${contextItem({
          label: "Assets",
          value: config?.assets.map((asset) => asset.toUpperCase()).join(", ") ?? "--",
        })}
        ${contextItem({
          label: "Model Table",
          value: config?.tableRange ?? "--",
        })}
      </div>
    </section>`;
}

function renderExecutionComparisonSection({
  summary,
  orders,
}: {
  readonly summary: DryRunReportSummary;
  readonly orders: readonly DryRunReportOrder[];
}): string {
  const finalizedOrders = orders.filter(isFinalized);
  const finalizedFilledOrders = finalizedOrders.filter(isActuallyFilled);
  const finalizedUnfilledOrders = finalizedOrders.filter(
    (order) => !isActuallyFilled(order),
  );
  return `
    <section class="alea-card with-corners">
      <div class="alea-card-header">
        <h2 class="alea-card-title">Filled vs Placed</h2>
      </div>
      <div class="comparison-grid">
        <div>
          <h3 class="subsection-title">Outcome Comparison</h3>
          <div class="alea-table-wrap">
            <table class="alea-table dense-table">
              <thead>
                <tr>
                  <th>Set</th>
                  <th>Trades</th>
                  <th>Win Rate</th>
                  <th>PnL</th>
                </tr>
              </thead>
              <tbody>
                ${comparisonRow({
                  label: "Filled only",
                  trades: summary.canonicalFilledCount,
                  winRate: summary.filledWinRate,
                  pnl: summary.canonicalPnlUsd,
                })}
                ${comparisonRow({
                  label: "Filled + unfilled",
                  trades: summary.finalizedOrderCount,
                  winRate: summary.allOrdersWinRate,
                  pnl: summary.allOrdersFilledPnlUsd,
                })}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <h3 class="subsection-title">Placement Distribution</h3>
          ${renderPlacementStatsTable({
            rows: [
              placementStatsRow({
                label: "Filled only",
                orders: finalizedFilledOrders,
              }),
              placementStatsRow({
                label: "Filled + unfilled",
                orders: finalizedOrders,
              }),
              placementStatsRow({
                label: "Unfilled only",
                orders: finalizedUnfilledOrders,
              }),
            ],
          })}
        </div>
      </div>
    </section>`;
}

function renderActualFilledSection({
  summary,
  orders,
}: {
  readonly summary: DryRunReportSummary;
  readonly orders: readonly DryRunReportOrder[];
}): string {
  return `
    <section class="alea-card with-corners">
      <div class="alea-card-header">
        <h2 class="alea-card-title">Actual Filled Trades</h2>
      </div>
      <div class="analysis-grid">
        <div>
          <h3 class="subsection-title">Filled Trade Summary</h3>
          <div class="alea-table-wrap">
            <table class="alea-table dense-table">
              <tbody>
                ${metricRow({
                  label: "Filled orders",
                  value: `${orders.length} observed`,
                  note: `${summary.canonicalFilledCount}/${summary.finalizedOrderCount} finalized orders filled (${formatPercent({
                    value: summary.canonicalFillRate,
                  })})`,
                })}
                ${metricRow({
                  label: "PnL",
                  value: formatUsd({ value: summary.canonicalPnlUsd }),
                  valueClass: signedClass({
                    value: summary.canonicalPnlUsd,
                    prefix: "num-",
                  }),
                  note: "canonical queue-aware filled shares only",
                })}
                ${metricRow({
                  label: "Win / loss",
                  value: `${summary.filledWinCount} / ${summary.filledLoseCount}`,
                  note: `${formatPercent({
                    value: summary.filledWinRate,
                  })} filled win rate`,
                })}
                ${metricRow({
                  label: "Fill latency",
                  value: formatDuration({ ms: summary.p90FillLatencyMs }),
                  note: `p90 · median ${formatDuration({
                    ms: summary.medianFillLatencyMs,
                  })} · mean ${formatDuration({
                    ms: summary.meanFillLatencyMs,
                  })}`,
                })}
                ${metricRow({
                  label: "Proxy mismatch",
                  value: String(summary.officialProxyDisagreementCount),
                  valueClass:
                    summary.officialProxyDisagreementCount > 0
                      ? "num-negative"
                      : "",
                  note: "official Polymarket outcome vs Binance proxy",
                })}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <h3 class="subsection-title">Filled Order Ledger</h3>
          ${renderFilledOrdersTable({ orders })}
        </div>
      </div>
    </section>`;
}

function renderPlacedCounterfactualSection({
  summary,
  orders,
  unfilledOrders,
}: {
  readonly summary: DryRunReportSummary;
  readonly orders: readonly DryRunReportOrder[];
  readonly unfilledOrders: readonly DryRunReportOrder[];
}): string {
  const touch = summarizeTouchOrders({ orders });
  const unfilledCount =
    summary.unfilledWouldWinCount + summary.unfilledWouldLoseCount;
  return `
    <section class="alea-card with-corners">
      <div class="alea-card-header">
        <h2 class="alea-card-title">Placed Order Counterfactuals</h2>
      </div>
      <div class="analysis-grid">
        <div>
          <h3 class="subsection-title">Scenario Comparison</h3>
          <div class="alea-table-wrap">
            <table class="alea-table dense-table">
              <thead>
                <tr>
                  <th>Scenario</th>
                  <th>Orders</th>
                  <th>Win</th>
                  <th>PnL</th>
                </tr>
              </thead>
              <tbody>
                ${scenarioRow({
                  label: "Actual queue fills",
                  orders: `${summary.canonicalFilledCount}/${summary.finalizedOrderCount}`,
                  winRate: formatPercent({ value: summary.filledWinRate }),
                  pnl: summary.canonicalPnlUsd,
                })}
                ${scenarioRow({
                  label: "All placed if filled",
                  orders: String(summary.finalizedOrderCount),
                  winRate: formatPercent({ value: summary.allOrdersWinRate }),
                  pnl: summary.allOrdersFilledPnlUsd,
                })}
                ${scenarioRow({
                  label: "Unfilled only if filled",
                  orders: String(unfilledCount),
                  winRate: formatPercent({
                    value: summary.unfilledWouldWinRate,
                  }),
                  pnl: summary.unfilledCounterfactualPnlUsd,
                })}
                ${scenarioRow({
                  label: "Optimistic touch",
                  orders: `${summary.touchFilledCount}/${summary.finalizedOrderCount}`,
                  winRate: formatPercent({ value: touch.winRate }),
                  pnl: summary.touchPnlUsd,
                })}
                ${scenarioRow({
                  label: "Actual - all-filled",
                  orders: "actual - all",
                  winRate: "--",
                  pnl: summary.fillSelectionDeltaUsd,
                })}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <h3 class="subsection-title">Unfilled Orders</h3>
          ${renderUnfilledOrdersTable({ orders: unfilledOrders })}
        </div>
      </div>
    </section>`;
}

function renderAssetTable({
  assets,
}: {
  readonly assets: readonly DryRunAssetSummary[];
}): string {
  return `
    <section class="alea-card">
      <div class="alea-card-header">
        <h2 class="alea-card-title">Asset Breakdown</h2>
      </div>
      <div class="alea-table-wrap">
        <table class="alea-table dense-table">
          <thead>
            <tr>
              <th rowspan="2">Asset</th>
              <th colspan="5" class="group-head">Actual Filled Trades</th>
              <th colspan="4" class="group-head">Placed Order Hypotheticals</th>
            </tr>
            <tr>
              <th>Placed</th>
              <th>Filled</th>
              <th>Fill</th>
              <th>Win</th>
              <th>PnL</th>
              <th>Unfilled W/L</th>
              <th>Unfilled CF</th>
              <th>All-Filled</th>
                  <th>Actual - All</th>
            </tr>
          </thead>
          <tbody>
            ${
              assets.length === 0
                ? emptyRow({ colspan: 10, label: "No assets recorded yet." })
                : assets.map((asset) => renderAssetRow({ asset })).join("")
            }
          </tbody>
        </table>
      </div>
    </section>`;
}

function renderWindowTable({
  windows,
}: {
  readonly windows: readonly DryRunWindowSummary[];
}): string {
  return `
    <section class="alea-card">
      <div class="alea-card-header">
        <h2 class="alea-card-title">Window Timeline</h2>
      </div>
      <div class="alea-table-wrap">
        <table class="alea-table dense-table">
          <thead>
            <tr>
              <th>Window</th>
              <th>Status</th>
              <th>Orders</th>
              <th>Filled</th>
              <th>Actual PnL</th>
              <th>Touch PnL</th>
              <th>All-Filled</th>
              <th>Actual - All</th>
              <th>Proxy</th>
            </tr>
          </thead>
          <tbody>
            ${
              windows.length === 0
                ? emptyRow({ colspan: 9, label: "No windows recorded yet." })
                : windows.map((window) => renderWindowRow({ window })).join("")
            }
          </tbody>
        </table>
      </div>
    </section>`;
}

function renderFilledOrdersTable({
  orders,
}: {
  readonly orders: readonly DryRunReportOrder[];
}): string {
  return `
    <div class="alea-table-wrap">
      <table class="alea-table dense-table">
        <thead>
          <tr>
            <th>Placed</th>
            <th>Asset</th>
            <th>Side</th>
            <th>Limit</th>
            <th>Filled</th>
            <th>Latency</th>
            <th>Outcome</th>
            <th>PnL</th>
            <th>Model</th>
            <th>Line / Entry</th>
          </tr>
        </thead>
        <tbody>
          ${
            orders.length === 0
              ? emptyRow({ colspan: 10, label: "No queue-aware fills yet." })
              : orders.map((order) => renderFilledOrderRow({ order })).join("")
          }
        </tbody>
      </table>
    </div>`;
}

function renderUnfilledOrdersTable({
  orders,
}: {
  readonly orders: readonly DryRunReportOrder[];
}): string {
  return `
    <div class="alea-table-wrap">
      <table class="alea-table dense-table">
        <thead>
          <tr>
            <th>Placed</th>
            <th>Asset</th>
            <th>Side</th>
            <th>Limit</th>
            <th>Queue</th>
            <th>Touch</th>
            <th>Outcome</th>
            <th>Would PnL</th>
            <th>Model</th>
            <th>Line / Entry</th>
          </tr>
        </thead>
        <tbody>
          ${
            orders.length === 0
              ? emptyRow({
                  colspan: 10,
                  label: "No unfilled finalized orders recorded.",
                })
              : orders.map((order) => renderUnfilledOrderRow({ order })).join("")
          }
        </tbody>
      </table>
    </div>`;
}

function renderParseErrors({
  errors,
}: {
  readonly errors: readonly string[];
}): string {
  if (errors.length === 0) {
    return "";
  }
  return `
    <section class="alea-card">
      <div class="alea-card-header">
        <h2 class="alea-card-title">Parse Warnings</h2>
      </div>
      <pre class="alea-error">${escapeHtml(errors.join("\n"))}</pre>
    </section>`;
}

function contextItem({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): string {
  return `
    <div class="context-item">
      <p class="context-label">${escapeHtml(label)}</p>
      <p class="context-value" title="${escapeHtml(value)}">${escapeHtml(value)}</p>
    </div>`;
}

function metricRow({
  label,
  value,
  note,
  valueClass = "",
}: {
  readonly label: string;
  readonly value: string;
  readonly note: string;
  readonly valueClass?: string;
}): string {
  return `
    <tr>
      <th>${escapeHtml(label)}</th>
      <td class="${valueClass}">${escapeHtml(value)}</td>
      <td class="note-cell">${escapeHtml(note)}</td>
    </tr>`;
}

function scenarioRow({
  label,
  orders,
  winRate,
  pnl,
}: {
  readonly label: string;
  readonly orders: string;
  readonly winRate: string;
  readonly pnl: number;
}): string {
  return `
    <tr>
      <th>${escapeHtml(label)}</th>
      <td>${escapeHtml(orders)}</td>
      <td>${escapeHtml(winRate)}</td>
      <td class="${signedClass({ value: pnl, prefix: "num-" })}">${formatUsd({
        value: pnl,
      })}</td>
    </tr>`;
}

function comparisonRow({
  label,
  trades,
  winRate,
  pnl,
}: {
  readonly label: string;
  readonly trades: number;
  readonly winRate: number | null;
  readonly pnl: number;
}): string {
  return `
    <tr>
      <th>${escapeHtml(label)}</th>
      <td>${trades}</td>
      <td>${formatPercent({ value: winRate })}</td>
      <td class="${signedClass({ value: pnl, prefix: "num-" })}">${formatUsd({
        value: pnl,
      })}</td>
    </tr>`;
}

function renderPlacementStatsTable({
  rows,
}: {
  readonly rows: readonly PlacementStatsRow[];
}): string {
  const filledOnly = rows[0] ?? emptyPlacementStatsRow({ label: "Filled only" });
  const filledAndUnfilled =
    rows[1] ?? emptyPlacementStatsRow({ label: "Filled + unfilled" });
  const unfilledOnly =
    rows[2] ?? emptyPlacementStatsRow({ label: "Unfilled only" });
  return `
    <div class="alea-table-wrap">
      <table class="alea-table dense-table">
        <thead>
          <tr>
            <th>Metric</th>
            <th>Stat</th>
            <th>Filled only</th>
            <th>Filled + unfilled</th>
            <th>Unfilled only</th>
          </tr>
        </thead>
        <tbody>
          ${renderPlacementMetricComparisonRows({
            metric: "Abs dist to line",
            filledOnly: filledOnly.absoluteDistanceToLinePct,
            filledAndUnfilled: filledAndUnfilled.absoluteDistanceToLinePct,
            unfilledOnly: unfilledOnly.absoluteDistanceToLinePct,
            formatter: formatPercentStat,
          })}
          ${renderPlacementMetricComparisonRows({
            metric: "Polymarket limit",
            filledOnly: filledOnly.limitPrice,
            filledAndUnfilled: filledAndUnfilled.limitPrice,
            unfilledOnly: unfilledOnly.limitPrice,
            formatter: formatPriceStat,
          })}
        </tbody>
      </table>
    </div>`;
}

function renderPlacementMetricComparisonRows({
  metric,
  filledOnly,
  filledAndUnfilled,
  unfilledOnly,
  formatter,
}: {
  readonly metric: string;
  readonly filledOnly: NumericStats;
  readonly filledAndUnfilled: NumericStats;
  readonly unfilledOnly: NumericStats;
  readonly formatter: (value: number | null) => string;
}): string {
  return [
    placementComparisonRow({
      metric,
      stat: "N",
      filledOnly: filledOnly.count,
      filledAndUnfilled: filledAndUnfilled.count,
      unfilledOnly: unfilledOnly.count,
      formatter: formatCountStat,
    }),
    placementComparisonRow({
      metric: "",
      stat: "Avg",
      filledOnly: filledOnly.avg,
      filledAndUnfilled: filledAndUnfilled.avg,
      unfilledOnly: unfilledOnly.avg,
      formatter,
    }),
    placementComparisonRow({
      metric: "",
      stat: "Median",
      filledOnly: filledOnly.median,
      filledAndUnfilled: filledAndUnfilled.median,
      unfilledOnly: unfilledOnly.median,
      formatter,
    }),
    placementComparisonRow({
      metric: "",
      stat: "P80",
      filledOnly: filledOnly.p80,
      filledAndUnfilled: filledAndUnfilled.p80,
      unfilledOnly: unfilledOnly.p80,
      formatter,
    }),
    placementComparisonRow({
      metric: "",
      stat: "P90",
      filledOnly: filledOnly.p90,
      filledAndUnfilled: filledAndUnfilled.p90,
      unfilledOnly: unfilledOnly.p90,
      formatter,
    }),
  ].join("");
}

function placementComparisonRow({
  metric,
  stat,
  filledOnly,
  filledAndUnfilled,
  unfilledOnly,
  formatter,
}: {
  readonly metric: string;
  readonly stat: string;
  readonly filledOnly: number | null;
  readonly filledAndUnfilled: number | null;
  readonly unfilledOnly: number | null;
  readonly formatter: (value: number | null) => string;
}): string {
  return `
    <tr>
      <th>${escapeHtml(metric)}</th>
      <td>${escapeHtml(stat)}</td>
      <td>${formatter(filledOnly)}</td>
      <td>${formatter(filledAndUnfilled)}</td>
      <td>${formatter(unfilledOnly)}</td>
    </tr>`;
}

function renderAssetRow({
  asset,
}: {
  readonly asset: DryRunAssetSummary;
}): string {
  return `
    <tr>
      <th>${asset.asset.toUpperCase()}</th>
      <td>${asset.finalizedOrderCount}</td>
      <td>${asset.canonicalFilledCount}</td>
      <td>${formatPercent({ value: asset.canonicalFillRate })}</td>
      <td>${formatPercent({ value: asset.filledWinRate })}</td>
      <td class="${signedClass({ value: asset.canonicalPnlUsd, prefix: "num-" })}">${formatUsd({ value: asset.canonicalPnlUsd })}</td>
      <td>${asset.unfilledWouldWinCount}/${asset.unfilledWouldLoseCount}</td>
      <td class="${signedClass({ value: asset.unfilledCounterfactualPnlUsd, prefix: "num-" })}">${formatUsd({ value: asset.unfilledCounterfactualPnlUsd })}</td>
      <td class="${signedClass({ value: asset.allOrdersFilledPnlUsd, prefix: "num-" })}">${formatUsd({ value: asset.allOrdersFilledPnlUsd })}</td>
      <td class="${signedClass({ value: asset.fillSelectionDeltaUsd, prefix: "num-" })}">${formatUsd({ value: asset.fillSelectionDeltaUsd })}</td>
    </tr>`;
}

function renderWindowRow({
  window,
}: {
  readonly window: DryRunWindowSummary;
}): string {
  const selectionDelta = window.canonicalPnlUsd - window.allOrdersFilledPnlUsd;
  return `
    <tr>
      <th>${formatWindow({ startMs: window.windowStartMs, endMs: window.windowEndMs })}</th>
      <td><span class="pill ${window.status === "pending" ? "pending" : ""}">${window.status}</span></td>
      <td>${window.orderCount}</td>
      <td>${window.canonicalFilledCount}</td>
      <td class="${signedClass({ value: window.canonicalPnlUsd, prefix: "num-" })}">${formatUsd({ value: window.canonicalPnlUsd })}</td>
      <td class="${signedClass({ value: window.touchPnlUsd, prefix: "num-" })}">${formatUsd({ value: window.touchPnlUsd })}</td>
      <td class="${signedClass({ value: window.allOrdersFilledPnlUsd, prefix: "num-" })}">${formatUsd({ value: window.allOrdersFilledPnlUsd })}</td>
      <td class="${signedClass({ value: selectionDelta, prefix: "num-" })}">${formatUsd({ value: selectionDelta })}</td>
      <td>${window.officialProxyDisagreementCount}</td>
    </tr>`;
}

function renderFilledOrderRow({
  order,
}: {
  readonly order: DryRunReportOrder;
}): string {
  return `
    <tr>
      <th>${orderTime({ order })}</th>
      <td>${order.asset.toUpperCase()}</td>
      <td>${arrow({ side: order.side })}</td>
      <td>${formatPrice({ value: order.limitPrice })}</td>
      <td>${formatShares({ value: order.canonicalFilledShares })}/${formatShares({ value: order.sharesIfFilled })}</td>
      <td>${formatDuration({ ms: order.canonicalFillLatencyMs })}</td>
      <td>${outcomePill({ order })}</td>
      <td class="${signedClass({ value: order.canonicalPnlUsd ?? 0, prefix: "num-" })}">${formatOptionalUsd({ value: order.canonicalPnlUsd })}</td>
      <td>${modelCell({ order })}</td>
      <td>${lineEntryCell({ order })}</td>
    </tr>`;
}

function renderUnfilledOrderRow({
  order,
}: {
  readonly order: DryRunReportOrder;
}): string {
  return `
    <tr>
      <th>${orderTime({ order })}</th>
      <td>${order.asset.toUpperCase()}</td>
      <td>${arrow({ side: order.side })}</td>
      <td>${formatPrice({ value: order.limitPrice })}</td>
      <td>${order.queueAheadShares === null ? "--" : formatShares({ value: order.queueAheadShares })}</td>
      <td>${order.touchFilledAtMs === null ? "--" : formatDuration({ ms: order.touchFillLatencyMs })}</td>
      <td>${outcomePill({ order })}</td>
      <td class="${signedClass({ value: order.allOrdersFilledPnlUsd ?? 0, prefix: "num-" })}">${formatOptionalUsd({ value: order.allOrdersFilledPnlUsd })}</td>
      <td>${modelCell({ order })}</td>
      <td>${lineEntryCell({ order })}</td>
    </tr>`;
}

function orderTime({ order }: { readonly order: DryRunReportOrder }): string {
  return `<div class="mono nowrap">${formatTime({
    ms: order.placedAtMs,
  })}</div><div class="order-id mono">${escapeHtml(order.id)}</div>`;
}

function outcomePill({ order }: { readonly order: DryRunReportOrder }): string {
  const outcomeClass =
    order.wonIfFilled === null ? "pending" : order.wonIfFilled ? "win" : "loss";
  const outcome =
    order.officialOutcome === null
      ? "pending"
      : `${arrow({ side: order.officialOutcome })} ${
          order.wonIfFilled ? "win" : "loss"
        }`;
  const proxyMismatch = order.officialProxyDisagreed
    ? `<br><span class="pill loss">proxy ${arrow({
        side: order.proxyOutcome ?? "up",
      })}</span>`
    : "";
  return `<span class="pill ${outcomeClass}">${escapeHtml(outcome)}</span>${proxyMismatch}`;
}

function modelCell({ order }: { readonly order: DryRunReportOrder }): string {
  return `p=${formatMaybeNumber({
    value: order.modelProbability,
    digits: 3,
  })}<br><span class="muted">edge=${formatMaybeSigned({
    value: order.edge,
  })}</span>`;
}

function lineEntryCell({
  order,
}: {
  readonly order: DryRunReportOrder;
}): string {
  return `<div class="line-pair">line ${formatMaybeNumber({
    value: order.line,
    digits: 5,
  })}<br>entry ${formatMaybeNumber({
    value: order.entryPrice,
    digits: 5,
  })}<br>dist ${formatPercentStat(absoluteDistanceToLinePct({ order }))}</div>`;
}

function emptyRow({
  colspan,
  label,
}: {
  readonly colspan: number;
  readonly label: string;
}): string {
  return `<tr><th colspan="${colspan}">${escapeHtml(label)}</th></tr>`;
}

type PlacementStatsRow = {
  readonly label: string;
  readonly absoluteDistanceToLinePct: NumericStats;
  readonly limitPrice: NumericStats;
};

type NumericStats = {
  readonly count: number;
  readonly avg: number | null;
  readonly median: number | null;
  readonly p80: number | null;
  readonly p90: number | null;
};

function placementStatsRow({
  label,
  orders,
}: {
  readonly label: string;
  readonly orders: readonly DryRunReportOrder[];
}): PlacementStatsRow {
  return {
    label,
    absoluteDistanceToLinePct: numericStats({
      values: orders.map((order) => absoluteDistanceToLinePct({ order })),
    }),
    limitPrice: numericStats({
      values: orders.map((order) => order.limitPrice),
    }),
  };
}

function emptyPlacementStatsRow({
  label,
}: {
  readonly label: string;
}): PlacementStatsRow {
  return {
    label,
    absoluteDistanceToLinePct: emptyNumericStats(),
    limitPrice: emptyNumericStats(),
  };
}

function emptyNumericStats(): NumericStats {
  return {
    count: 0,
    avg: null,
    median: null,
    p80: null,
    p90: null,
  };
}

function numericStats({
  values,
}: {
  readonly values: readonly (number | null)[];
}): NumericStats {
  const cleanValues = values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  if (cleanValues.length === 0) {
    return emptyNumericStats();
  }
  return {
    count: cleanValues.length,
    avg:
      cleanValues.reduce((acc, value) => acc + value, 0) / cleanValues.length,
    median: percentile({ values: cleanValues, p: 0.5 }),
    p80: percentile({ values: cleanValues, p: 0.8 }),
    p90: percentile({ values: cleanValues, p: 0.9 }),
  };
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

function absoluteDistanceToLinePct({
  order,
}: {
  readonly order: DryRunReportOrder;
}): number | null {
  if (
    order.line === null ||
    order.entryPrice === null ||
    order.entryPrice <= 0
  ) {
    return null;
  }
  return (Math.abs(order.line - order.entryPrice) / order.entryPrice) * 100;
}

function isFinalized(order: DryRunReportOrder): boolean {
  return order.officialOutcome !== null;
}

function isActuallyFilled(order: DryRunReportOrder): boolean {
  return order.canonicalFilledShares > 0;
}

function summarizeTouchOrders({
  orders,
}: {
  readonly orders: readonly DryRunReportOrder[];
}): { readonly winRate: number | null } {
  const finalizedTouchOrders = orders.filter(
    (order) => order.officialOutcome !== null && order.touchFilledAtMs !== null,
  );
  if (finalizedTouchOrders.length === 0) {
    return { winRate: null };
  }
  const wins = finalizedTouchOrders.filter((order) => order.wonIfFilled).length;
  return { winRate: wins / finalizedTouchOrders.length };
}

function arrow({ side }: { readonly side: "up" | "down" }): string {
  return side === "up" ? "↑" : "↓";
}

function formatWindow({
  startMs,
  endMs,
}: {
  readonly startMs: number;
  readonly endMs: number;
}): string {
  return `${formatTime({ ms: startMs })} → ${formatTime({ ms: endMs })}`;
}

function formatTime({ ms }: { readonly ms: number }): string {
  return new Date(ms).toISOString().slice(11, 16);
}

function formatDateTime({ ms }: { readonly ms: number }): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function formatUsd({ value }: { readonly value: number }): string {
  if (value === 0) {
    return "$0.00";
  }
  const sign = value > 0 ? "+" : "-";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function formatOptionalUsd({
  value,
}: {
  readonly value: number | null;
}): string {
  return value === null ? "--" : formatUsd({ value });
}

function formatPercent({ value }: { readonly value: number | null }): string {
  return value === null ? "--" : `${(value * 100).toFixed(1)}%`;
}

function formatPercentStat(value: number | null): string {
  if (value === null) {
    return "--";
  }
  return `${trimFixed({ value, digits: 3 })}%`;
}

function formatCountStat(value: number | null): string {
  return value === null ? "--" : String(value);
}

function formatDuration({ ms }: { readonly ms: number | null }): string {
  if (ms === null) {
    return "--";
  }
  if (ms < 1_000) {
    return `${Math.round(ms)}ms`;
  }
  return `${trimFixed({ value: Math.round(ms / 100) / 10, digits: 1 })}s`;
}

function formatShares({ value }: { readonly value: number }): string {
  return trimFixed({ value, digits: 2 });
}

function formatPrice({ value }: { readonly value: number }): string {
  return `$${trimFixed({ value, digits: value < 1 ? 4 : 2 })}`;
}

function formatPriceStat(value: number | null): string {
  return value === null ? "--" : formatPrice({ value });
}

function formatMaybeNumber({
  value,
  digits,
}: {
  readonly value: number | null;
  readonly digits: number;
}): string {
  return value === null ? "--" : value.toFixed(digits);
}

function formatMaybeSigned({
  value,
}: {
  readonly value: number | null;
}): string {
  if (value === null) {
    return "--";
  }
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(3)}`;
}

function signedClass({
  value,
  prefix = "",
}: {
  readonly value: number;
  readonly prefix?: string;
}): string {
  if (value > 0) {
    return `${prefix}positive`;
  }
  if (value < 0) {
    return `${prefix}negative`;
  }
  return "";
}

function trimFixed({
  value,
  digits,
}: {
  readonly value: number;
  readonly digits: number;
}): string {
  return value.toFixed(digits).replace(/\.?0+$/, "");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
