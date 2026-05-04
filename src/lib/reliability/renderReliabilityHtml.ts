import {
  baselineReliabilitySource,
  comparableReliabilitySourceValues,
  type DirectionalOutcome,
  type ReliabilityAssetWindow,
  type ReliabilityCapturePayload,
  type ReliabilitySource,
  type ReliabilitySourceCell,
} from "@alea/lib/reliability/types";
import {
  aleaBrandMark,
  aleaDesignSystemHead,
} from "@alea/lib/ui/aleaDesignSystem";

export function renderReliabilityHtml({
  payload,
}: {
  readonly payload: ReliabilityCapturePayload;
}): string {
  const subtitle = [
    `${payload.assets.map((asset) => asset.toUpperCase()).join(", ")}`,
    `started ${formatDateTime({ ms: payload.startedAtMs })}`,
    payload.requestedDurationMs === 0
      ? "indefinite"
      : `${formatDuration({ ms: payload.requestedDurationMs })} requested`,
    `${payload.completedWindows.length} asset-windows`,
  ].join('<span class="sep">·</span>');

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Alea · Directional Agreement</title>
  ${aleaDesignSystemHead()}
  <style>
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
    }
    .metric {
      border: 1px solid var(--alea-border-muted);
      border-radius: 10px;
      padding: 16px;
      background: linear-gradient(180deg, var(--alea-panel-2), var(--alea-bg-soft));
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
      font-size: 30px;
      line-height: 1;
      color: var(--alea-text);
      font-variant-numeric: tabular-nums;
    }
    .bar-track {
      width: 100%;
      height: 7px;
      border-radius: 999px;
      overflow: hidden;
      background: rgba(215, 170, 69, 0.1);
      border: 1px solid var(--alea-border-faint);
    }
    .bar-fill {
      height: 100%;
      background: linear-gradient(90deg, var(--alea-green), var(--alea-gold));
    }
    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 54px;
      padding: 3px 8px;
      border-radius: 999px;
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      border: 1px solid var(--alea-border-muted);
    }
    .badge.ok { color: var(--alea-green); border-color: rgba(70, 195, 123, 0.45); background: rgba(70, 195, 123, 0.08); }
    .badge.diff { color: var(--alea-red); border-color: rgba(216, 90, 79, 0.5); background: rgba(216, 90, 79, 0.09); }
    .badge.miss { color: var(--alea-text-muted); }
    .ledger-row.diff td,
    .ledger-row.diff th {
      background: rgba(216, 90, 79, 0.055);
    }
    .ledger-price-cell {
      display: grid;
      grid-template-columns: 36px 46px minmax(74px, 1fr);
      align-items: baseline;
      column-gap: 8px;
      min-width: 164px;
      text-align: left;
    }
    .ledger-price-cell.baseline {
      grid-template-columns: 46px minmax(74px, 1fr) auto;
    }
    .ledger-status {
      min-width: 0;
      width: 36px;
      padding: 2px 5px;
      font-size: 9px;
      line-height: 1;
      letter-spacing: 0.08em;
    }
    .ledger-outcome {
      min-width: 46px;
      font-size: 11px;
      font-weight: 700;
      color: var(--alea-text);
    }
    .ledger-delta {
      justify-self: end;
      white-space: nowrap;
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .near-zero-chip {
      justify-self: start;
      white-space: nowrap;
      border: 1px solid rgba(215, 170, 69, 0.32);
      border-radius: 999px;
      padding: 2px 6px;
      color: var(--alea-text-muted);
      background: rgba(215, 170, 69, 0.05);
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .source-name {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .source-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
    }
    .mono { font-family: var(--alea-font-mono); }
    @media (max-width: 980px) {
      .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 640px) {
      .summary-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="alea-shell">
    <header class="alea-header">
      <div class="alea-brand-row">${aleaBrandMark()}</div>
      <h1 class="alea-title">Directional Agreement</h1>
      <p class="alea-subtitle">${subtitle}</p>
    </header>
    <main class="alea-main">
      <section class="summary-grid">
        ${renderMetric({
          label: "Comparable windows",
          value: payload.summary.sources
            .reduce((acc, item) => acc + item.comparableWindows, 0)
            .toLocaleString(),
        })}
        ${renderMetric({
          label: "Agreement rate",
          value: formatPercent({
            value: weightedAgreementRate({ payload }),
          }),
        })}
        ${renderMetric({
          label: "Disagreements",
          value: payload.summary.sources
            .reduce((acc, item) => acc + item.disagreements, 0)
            .toLocaleString(),
        })}
      </section>

      <section class="alea-card with-corners">
        <div class="alea-section-rule"><h2>Source Agreement</h2></div>
        <div class="alea-table-wrap">
          <table class="alea-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Agreement</th>
                <th>Comparable</th>
                <th>OK</th>
                <th>Diff</th>
                <th>Unavailable</th>
                <th>Near-zero diff</th>
              </tr>
            </thead>
            <tbody>${payload.summary.sources.map(renderSourceSummaryRow).join("")}</tbody>
          </table>
        </div>
      </section>

      <section class="alea-card with-corners">
        <div class="alea-section-rule"><h2>Asset Breakdown</h2></div>
        <div class="alea-table-wrap">
          <table class="alea-table">
            <thead>
              <tr>
                <th>Asset / Source</th>
                <th>Agreement</th>
                <th>Comparable</th>
                <th>OK</th>
                <th>Diff</th>
                <th>Unavailable</th>
              </tr>
            </thead>
            <tbody>${payload.summary.byAsset.map(renderAssetSummaryRow).join("")}</tbody>
          </table>
        </div>
      </section>

      <section class="alea-card with-corners">
        <div class="alea-section-rule"><h2>Source Health</h2></div>
        <div class="alea-table-wrap">
          <table class="alea-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Status</th>
                <th>Ticks</th>
                <th>Connects</th>
                <th>Disconnects</th>
                <th>Errors</th>
                <th>Last Tick</th>
              </tr>
            </thead>
            <tbody>${payload.sourceHealth.map(renderHealthRow).join("")}</tbody>
          </table>
        </div>
      </section>

      <section class="alea-card with-corners">
        <div class="alea-section-rule"><h2>Window Ledger</h2></div>
        <div class="alea-table-wrap">
          <table class="alea-table">
            <thead>
              <tr>
                <th>Window</th>
                <th>Asset</th>
                <th>Polymarket</th>
                <th>Coinbase spot</th>
                <th>Coinbase perp</th>
                <th>Binance spot</th>
                <th>Binance perp</th>
              </tr>
            </thead>
            <tbody>${payload.completedWindows
              .map((window) =>
                renderLedgerRow({
                  window,
                  nearZeroThresholdBp: payload.nearZeroThresholdBp,
                }),
              )
              .join("")}</tbody>
          </table>
        </div>
      </section>
    </main>
  </div>
</body>
</html>`;
}

function renderMetric({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): string {
  return `<div class="metric"><p class="metric-label">${escapeHtml(label)}</p><p class="metric-value">${escapeHtml(value)}</p></div>`;
}

function renderSourceSummaryRow(
  item: ReliabilityCapturePayload["summary"]["sources"][number],
): string {
  return `<tr>
    <th>${sourceLabel({ source: item.source })}</th>
    <td>${renderAgreementBar({ rate: item.agreementRate })}</td>
    <td>${item.comparableWindows.toLocaleString()}</td>
    <td>${item.agreements.toLocaleString()}</td>
    <td>${item.disagreements.toLocaleString()}</td>
    <td>${item.unavailable.toLocaleString()}</td>
    <td>${item.nearZeroDisagreements.toLocaleString()} / ${item.nearZeroComparable.toLocaleString()}</td>
  </tr>`;
}

function renderAssetSummaryRow(
  item: ReliabilityCapturePayload["summary"]["byAsset"][number],
): string {
  return `<tr>
    <th>${escapeHtml(item.asset.toUpperCase())} ${sourceLabel({ source: item.source })}</th>
    <td>${renderAgreementBar({ rate: item.agreementRate })}</td>
    <td>${item.comparableWindows.toLocaleString()}</td>
    <td>${item.agreements.toLocaleString()}</td>
    <td>${item.disagreements.toLocaleString()}</td>
    <td>${item.unavailable.toLocaleString()}</td>
  </tr>`;
}

function renderHealthRow(
  item: ReliabilityCapturePayload["sourceHealth"][number],
): string {
  return `<tr>
    <th>${sourceLabel({ source: item.source })}</th>
    <td>${item.connected ? '<span class="badge ok">open</span>' : '<span class="badge miss">closed</span>'}</td>
    <td>${item.ticks.toLocaleString()}</td>
    <td>${item.connectCount.toLocaleString()}</td>
    <td>${item.disconnectCount.toLocaleString()}</td>
    <td>${item.errorCount.toLocaleString()}</td>
    <td>${item.lastTickAtMs === null ? "—" : formatTime({ ms: item.lastTickAtMs })}</td>
  </tr>`;
}

function renderLedgerRow({
  window,
  nearZeroThresholdBp,
}: {
  readonly window: ReliabilityAssetWindow;
  readonly nearZeroThresholdBp: number;
}): string {
  const hasDiff = comparableReliabilitySourceValues.some(
    (source) => window.sources[source].agreesWithPolymarket === false,
  );
  const baseline = window.sources[baselineReliabilitySource];
  const nearZero =
    baseline.deltaBp !== null &&
    Math.abs(baseline.deltaBp) <= nearZeroThresholdBp &&
    baseline.status === "complete";
  return `<tr class="ledger-row${hasDiff ? " diff" : ""}${nearZero ? " near-zero" : ""}">
    <th><span class="mono">${formatTime({ ms: window.windowStartMs })}</span></th>
    <td>${escapeHtml(window.asset.toUpperCase())}</td>
    <td>${renderBaselineCell({
      cell: baseline,
      nearZero,
      nearZeroThresholdBp,
    })}</td>
    ${comparableReliabilitySourceValues
      .map(
        (source) =>
          `<td>${renderComparableCell({ cell: window.sources[source] })}</td>`,
      )
      .join("")}
  </tr>`;
}

function renderBaselineCell({
  cell,
  nearZero,
  nearZeroThresholdBp,
}: {
  readonly cell: ReliabilitySourceCell;
  readonly nearZero: boolean;
  readonly nearZeroThresholdBp: number;
}): string {
  if (cell.status !== "complete") {
    return `<span class="badge miss ledger-status" title="${escapeHtml(cell.status)}">${escapeHtml(statusLabel({ status: cell.status }))}</span>`;
  }
  return `<div class="ledger-price-cell baseline"><span class="ledger-outcome">${renderOutcome({ outcome: cell.outcome })}</span><span class="mono ledger-delta">${formatDelta({ cell })}</span>${nearZero ? `<span class="near-zero-chip" title="Polymarket Chainlink moved no more than ${nearZeroThresholdBp} bp">near 0</span>` : ""}</div>`;
}

function renderComparableCell({
  cell,
}: {
  readonly cell: ReliabilitySourceCell;
}): string {
  const badge =
    cell.agreesWithPolymarket === true
      ? '<span class="badge ok ledger-status">OK</span>'
      : cell.agreesWithPolymarket === false
        ? '<span class="badge diff ledger-status">DIFF</span>'
        : `<span class="badge miss ledger-status" title="${escapeHtml(cell.status)}">${escapeHtml(statusLabel({ status: cell.status }))}</span>`;
  return `<div class="ledger-price-cell">${badge}<span class="ledger-outcome">${renderOutcome({ outcome: cell.outcome })}</span><span class="mono ledger-delta">${formatDelta({ cell })}</span></div>`;
}

function statusLabel({
  status,
}: {
  readonly status: ReliabilitySourceCell["status"];
}): string {
  switch (status) {
    case "complete":
      return "OK";
    case "missing-start":
    case "missing-end":
      return "MISS";
    case "stale-start":
    case "stale-end":
      return "STALE";
    case "no-market":
      return "NOMKT";
    case "pending":
      return "PEND";
  }
}

function renderAgreementBar({
  rate,
}: {
  readonly rate: number | null;
}): string {
  const pct = rate === null ? 0 : Math.max(0, Math.min(100, rate * 100));
  return `<div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(2)}%"></div></div><span class="mono">${formatPercent({ value: rate })}</span>`;
}

function weightedAgreementRate({
  payload,
}: {
  readonly payload: ReliabilityCapturePayload;
}): number | null {
  const comparable = payload.summary.sources.reduce(
    (acc, item) => acc + item.comparableWindows,
    0,
  );
  if (comparable === 0) {
    return null;
  }
  const agreements = payload.summary.sources.reduce(
    (acc, item) => acc + item.agreements,
    0,
  );
  return agreements / comparable;
}

function sourceLabel({
  source,
}: {
  readonly source: ReliabilitySource;
}): string {
  return `<span class="source-name"><span class="source-dot" style="background:${sourceColor({ source })}"></span>${escapeHtml(source)}</span>`;
}

function sourceColor({
  source,
}: {
  readonly source: ReliabilitySource;
}): string {
  switch (source) {
    case "polymarket-chainlink":
      return "#ff5470";
    case "coinbase-spot":
      return "#2a8bff";
    case "coinbase-perp":
      return "#5fa8ff";
    case "binance-spot":
      return "#f0b90b";
    case "binance-perp":
      return "#d99d2c";
  }
}

function renderOutcome({
  outcome,
}: {
  readonly outcome: DirectionalOutcome | null;
}): string {
  if (outcome === null) {
    return "—";
  }
  return outcome === "up" ? "UP" : "DOWN";
}

function formatDelta({
  cell,
}: {
  readonly cell: ReliabilitySourceCell;
}): string {
  if (cell.deltaBp === null) {
    return "";
  }
  const sign = cell.deltaBp >= 0 ? "+" : "";
  return `${sign}${cell.deltaBp.toFixed(2)} bp`;
}

function formatPercent({ value }: { readonly value: number | null }): string {
  if (value === null) {
    return "—";
  }
  return `${(value * 100).toFixed(1)}%`;
}

function formatTime({ ms }: { readonly ms: number }): string {
  return new Date(ms).toISOString().slice(11, 16);
}

function formatDateTime({ ms }: { readonly ms: number }): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function formatDuration({ ms }: { readonly ms: number }): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 60 && minutes % 60 === 0) {
    return `${minutes / 60}h`;
  }
  return `${minutes}m`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
