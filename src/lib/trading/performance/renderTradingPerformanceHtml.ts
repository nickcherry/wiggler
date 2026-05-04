import type { TradingPerformancePayload } from "@alea/lib/trading/performance/types";
import {
  aleaBrandMark,
  aleaChartTokens,
  aleaDesignSystemHead,
} from "@alea/lib/ui/aleaDesignSystem";

export function renderTradingPerformanceHtml({
  payload,
}: {
  readonly payload: TradingPerformancePayload;
}): string {
  const subtitle = [
    `wallet ${shortAddress({ value: payload.walletAddress })}`,
    `generated ${formatDateTime({ ms: payload.generatedAtMs })}`,
    "Polymarket CLOB API only",
    `${payload.summary.tradeCount.toLocaleString()} trades`,
  ].join('<span class="sep">&middot;</span>');
  const payloadJson = escapeJsonForHtml({ value: JSON.stringify(payload) });
  const chartTokensJson = JSON.stringify(aleaChartTokens);

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Alea &middot; Polymarket Trading Performance</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/uplot@1.6.30/dist/uPlot.min.css" />
  <script src="https://cdn.jsdelivr.net/npm/uplot@1.6.30/dist/uPlot.iife.min.js" charset="utf-8"></script>
  ${aleaDesignSystemHead()}
  <style>
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
    }
    .metric {
      border: 1px solid var(--alea-border-muted);
      border-radius: 10px;
      padding: 16px;
      background: linear-gradient(180deg, var(--alea-panel-2), var(--alea-bg-soft));
      min-width: 0;
    }
    .metric-label {
      margin: 0 0 8px;
      color: var(--alea-text-muted);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }
    .metric-value {
      margin: 0;
      font-family: var(--alea-font-display);
      font-size: 29px;
      line-height: 1;
      color: var(--alea-text);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .metric-value.positive { color: var(--alea-green); }
    .metric-value.negative { color: var(--alea-red); }
    .metric-sub {
      margin: 8px 0 0;
      color: var(--alea-text-subtle);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .chart-frame {
      position: relative;
      border-radius: 10px;
      background:
        radial-gradient(circle at 92% 10%, rgba(215, 170, 69, 0.05), transparent 36%),
        linear-gradient(180deg, rgba(15, 27, 18, 0.6), rgba(7, 9, 10, 0.4));
      border: 1px solid var(--alea-border-muted);
      padding: 12px 8px 6px;
    }
    .chart-host {
      position: relative;
      width: 100%;
      height: 370px;
      min-height: 370px;
      max-height: 370px;
    }
    .chart-empty {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--alea-text-subtle);
      font-size: 12.5px;
      letter-spacing: 0.04em;
    }
    .source-line {
      margin: 12px 0 0;
      color: var(--alea-text-subtle);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .trade-market {
      display: flex;
      flex-direction: column;
      gap: 3px;
      min-width: 270px;
      max-width: 460px;
    }
    .trade-question {
      color: var(--alea-text);
      font-size: 12.5px;
      line-height: 1.35;
      text-transform: none;
      letter-spacing: 0;
      font-weight: 600;
    }
    .trade-sub {
      color: var(--alea-text-subtle);
      font-size: 10.5px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .symbol-pill,
    .result-pill,
    .role-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      padding: 3px 8px;
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      border: 1px solid var(--alea-border-muted);
      white-space: nowrap;
    }
    .symbol-pill {
      color: var(--alea-gold);
      background: rgba(215, 170, 69, 0.06);
    }
    .result-pill.win {
      color: var(--alea-green);
      border-color: rgba(70, 195, 123, 0.45);
      background: rgba(70, 195, 123, 0.08);
    }
    .result-pill.loss {
      color: var(--alea-red);
      border-color: rgba(216, 90, 79, 0.5);
      background: rgba(216, 90, 79, 0.09);
    }
    .result-pill.flat,
    .result-pill.open,
    .role-pill {
      color: var(--alea-text-muted);
      background: rgba(215, 170, 69, 0.035);
    }
    .num-positive { color: var(--alea-green) !important; }
    .num-negative { color: var(--alea-red) !important; }
    .mono { font-family: var(--alea-font-mono); }
    .nowrap { white-space: nowrap; }
    @media (max-width: 1120px) {
      .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 680px) {
      .summary-grid { grid-template-columns: 1fr; }
      .metric-value { font-size: 25px; }
      .chart-host { height: 290px; min-height: 290px; max-height: 290px; }
    }
  </style>
</head>
<body>
  <div class="alea-shell">
    <header class="alea-header">
      <div class="alea-brand-row">${aleaBrandMark()}</div>
      <h1 class="alea-title">Polymarket Trading Performance</h1>
      <p class="alea-subtitle">${subtitle}</p>
    </header>
    <main class="alea-main">
      <section class="summary-grid">
        ${renderMetric({
          label: "Lifetime PnL",
          value: formatSignedUsd({ value: payload.summary.lifetimePnlUsd }),
          tone: toneForNumber({ value: payload.summary.lifetimePnlUsd }),
          sub: `${payload.summary.resolvedMarketCount.toLocaleString()} resolved markets`,
        })}
        ${renderMetric({
          label: "Resolved Trades",
          value: payload.summary.resolvedTradeCount.toLocaleString(),
          sub: `${payload.summary.unresolvedTradeCount.toLocaleString()} open or unresolved`,
        })}
        ${renderMetric({
          label: "Win / Loss",
          value: `${payload.summary.winningTradeCount.toLocaleString()} / ${payload.summary.losingTradeCount.toLocaleString()}`,
          sub: `${payload.summary.flatTradeCount.toLocaleString()} flat trades`,
        })}
        ${renderMetric({
          label: "Fees",
          value: formatUnsignedUsd({ value: payload.summary.resolvedFeesUsd }),
          sub: `${formatUnsignedUsd({ value: payload.summary.totalVolumeUsd })} volume`,
        })}
      </section>

      <section class="alea-card with-corners">
        <div class="alea-card-header">
          <h2 class="alea-card-title">Cumulative Resolved PnL</h2>
          <p class="alea-card-meta">Recognized at market end when the CLOB market exposes an end time.</p>
        </div>
        <div class="chart-frame">
          <div id="pnl-chart" class="chart-host"></div>
          <div id="pnl-empty" class="chart-empty">No resolved PnL to chart yet.</div>
          <div id="pnl-tooltip" class="alea-tooltip"></div>
        </div>
        <p class="source-line">Source: ${escapeHtml({ value: payload.source.trades })}; ${escapeHtml({ value: payload.source.markets })}.</p>
      </section>

      <section class="alea-card with-corners">
        <div class="alea-section-rule"><h2>Trades</h2></div>
        <div class="alea-table-wrap">
          <table class="alea-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Symbol</th>
                <th>Market</th>
                <th>Outcome</th>
                <th>Side</th>
                <th>Price</th>
                <th>Resolved</th>
                <th>Shares</th>
                <th>Notional</th>
                <th>Fee</th>
                <th>PnL</th>
                <th>Result</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>${payload.trades.map(renderTradeRow).join("")}</tbody>
          </table>
        </div>
      </section>
    </main>
  </div>
  <script id="performance-payload" type="application/json">${payloadJson}</script>
  <script>
    const payload = JSON.parse(document.getElementById("performance-payload").textContent);
    const tokens = ${chartTokensJson};
    const host = document.getElementById("pnl-chart");
    const empty = document.getElementById("pnl-empty");
    const tooltip = document.getElementById("pnl-tooltip");
    let plot = null;

    function formatUsd(value) {
      const sign = value > 0 ? "+" : value < 0 ? "-" : "";
      return sign + "$" + Math.abs(value).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    }

    function buildSeries() {
      const points = payload.chart;
      if (points.length === 0) {
        return null;
      }
      const xs = points.map((point) => point.settledAtMs / 1000);
      const ys = points.map((point) => point.cumulativePnlUsd);
      if (points.length === 1) {
        xs.unshift(xs[0] - 1);
        ys.unshift(0);
      }
      return { points, xs, ys };
    }

    function renderChart() {
      const series = buildSeries();
      if (plot !== null) {
        plot.destroy();
        plot = null;
      }
      host.innerHTML = "";
      if (series === null) {
        empty.style.display = "flex";
        return;
      }
      empty.style.display = "none";
      const width = Math.max(320, Math.floor(host.getBoundingClientRect().width));
      const height = Math.max(260, Math.floor(host.getBoundingClientRect().height));
      plot = new uPlot(
        {
          width,
          height,
          cursor: { drag: { x: true, y: false } },
          scales: { x: { time: true } },
          series: [
            {},
            {
              label: "Cumulative PnL",
              stroke: "#d7aa45",
              width: 3,
              value: (_self, raw) => raw == null ? "--" : formatUsd(raw),
            },
          ],
          axes: [
            {
              stroke: tokens.axisStroke,
              grid: { stroke: tokens.gridStroke, width: 1 },
              ticks: { stroke: tokens.axisTickStroke, width: 1 },
              font: tokens.axisFont,
            },
            {
              stroke: tokens.axisStroke,
              grid: { stroke: tokens.gridStroke, width: 1 },
              ticks: { stroke: tokens.axisTickStroke, width: 1 },
              font: tokens.axisFont,
              values: (_self, vals) => vals.map((value) => formatUsd(value)),
            },
          ],
          hooks: {
            setCursor: [
              (self) => {
                const index = self.cursor.idx;
                if (index == null) {
                  tooltip.classList.remove("visible");
                  return;
                }
                const syntheticOffset = series.xs.length - series.points.length;
                const point = series.points[index - syntheticOffset];
                if (!point) {
                  tooltip.classList.remove("visible");
                  return;
                }
                tooltip.innerHTML =
                  '<div class="alea-tooltip-head">' + new Date(point.settledAtMs).toLocaleString() + '</div>' +
                  '<div class="alea-tooltip-row"><span></span><span class="name">Market</span><span class="value">' + point.symbol + '</span></div>' +
                  '<div class="alea-tooltip-row"><span></span><span class="name">Market PnL</span><span class="value">' + formatUsd(point.marketPnlUsd) + '</span></div>' +
                  '<div class="alea-tooltip-row"><span></span><span class="name">Total PnL</span><span class="value">' + formatUsd(point.cumulativePnlUsd) + '</span></div>';
                const rect = host.getBoundingClientRect();
                tooltip.style.left = Math.min(rect.width - 230, Math.max(8, self.cursor.left + 12)) + "px";
                tooltip.style.top = Math.max(8, self.cursor.top + 12) + "px";
                tooltip.classList.add("visible");
              },
            ],
          },
        },
        [series.xs, series.ys],
        host,
      );
    }

    renderChart();
    window.addEventListener("resize", () => {
      window.clearTimeout(window.__aleaPnlResize);
      window.__aleaPnlResize = window.setTimeout(renderChart, 120);
    });
  </script>
</body>
</html>`;
}

function renderMetric({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  readonly label: string;
  readonly value: string;
  readonly sub: string;
  readonly tone?: "positive" | "negative" | "neutral";
}): string {
  const toneClass = tone === "neutral" ? "" : ` ${tone}`;
  return `
    <div class="metric">
      <p class="metric-label">${escapeHtml({ value: label })}</p>
      <p class="metric-value${toneClass}">${escapeHtml({ value })}</p>
      <p class="metric-sub">${escapeHtml({ value: sub })}</p>
    </div>
  `;
}

function renderTradeRow(
  row: TradingPerformancePayload["trades"][number],
): string {
  const pnlClass =
    row.pnlUsd === null
      ? ""
      : row.pnlUsd > 0
        ? " num-positive"
        : row.pnlUsd < 0
          ? " num-negative"
          : "";
  const notionalClass = row.side === "BUY" ? "num-negative" : "num-positive";
  return `
    <tr>
      <th class="nowrap">${escapeHtml({ value: formatDateTime({ ms: row.tradeTimeMs }) })}</th>
      <td><span class="symbol-pill">${escapeHtml({ value: row.symbol })}</span></td>
      <td>
        <div class="trade-market">
          <span class="trade-question">${escapeHtml({ value: row.question })}</span>
          <span class="trade-sub">${escapeHtml({ value: row.marketSlug ?? shortId({ value: row.conditionId }) })}</span>
        </div>
      </td>
      <td>${escapeHtml({ value: row.outcome })}</td>
      <td class="mono">${row.side}</td>
      <td class="mono">${formatPrice({ value: row.price })}</td>
      <td class="mono">${row.resolvedPrice === null ? "--" : formatPrice({ value: row.resolvedPrice })}</td>
      <td class="mono">${formatNumber({ value: row.size, maximumFractionDigits: 4 })}</td>
      <td class="mono ${notionalClass}">${row.side === "BUY" ? "-" : "+"}${formatUnsignedUsd({ value: row.notionalUsd })}</td>
      <td class="mono">${formatUnsignedUsd({ value: row.feeUsd })}</td>
      <td class="mono${pnlClass}">${row.pnlUsd === null ? "--" : formatSignedUsd({ value: row.pnlUsd })}</td>
      <td><span class="result-pill ${row.result}">${row.result}</span></td>
      <td><span class="role-pill">${row.traderSide}</span></td>
    </tr>
  `;
}

function formatDateTime({ ms }: { readonly ms: number }): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "unknown";
  }
  return new Date(ms).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatSignedUsd({ value }: { readonly value: number }): string {
  if (value === 0) {
    return "$0.00";
  }
  const sign = value > 0 ? "+" : "-";
  return `${sign}${formatUnsignedUsd({ value: Math.abs(value) })}`;
}

function formatUnsignedUsd({ value }: { readonly value: number }): string {
  return `$${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPrice({ value }: { readonly value: number }): string {
  return value.toFixed(3);
}

function formatNumber({
  value,
  maximumFractionDigits,
}: {
  readonly value: number;
  readonly maximumFractionDigits: number;
}): string {
  return value.toLocaleString("en-US", { maximumFractionDigits });
}

function toneForNumber({
  value,
}: {
  readonly value: number;
}): "positive" | "negative" | "neutral" {
  if (value > 0) {
    return "positive";
  }
  if (value < 0) {
    return "negative";
  }
  return "neutral";
}

function shortAddress({ value }: { readonly value: string }): string {
  if (value.length <= 12) {
    return value;
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function shortId({ value }: { readonly value: string }): string {
  if (value.length <= 14) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function escapeHtml({ value }: { readonly value: string }): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeJsonForHtml({ value }: { readonly value: string }): string {
  return value.replaceAll("<", "\\u003c");
}
