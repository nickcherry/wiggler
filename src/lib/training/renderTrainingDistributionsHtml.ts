import type {
  AssetSizeDistribution,
  TrainingDistributionsPayload,
} from "@wiggler/lib/training/types";

/**
 * Brand colors reused from the latency dashboard's palette so the two
 * temp-dashboards feel like they belong to the same product. Body = "the
 * move" (close minus open); wick = "the envelope" (high minus low).
 */
const bodyColor = "#0052ff";
const wickColor = "#ff8533";

/**
 * Percentiles to render in the upper-tail table. Chart shows all 101 points
 * regardless; the table is a focused readout of the right half of the
 * distribution where threshold decisions get made.
 */
const tableTailPercentiles: readonly number[] = [
  100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50,
];

type DashboardAssetSlice = {
  readonly asset: string;
  readonly assetUpper: string;
  readonly candleCount: number;
  readonly yearRange: string | null;
  readonly body: readonly number[];
  readonly wick: readonly number[];
};

/**
 * Renders a self-contained light-themed HTML dashboard for the
 * `training:distributions` analysis. One tab per asset; each tab has a
 * uPlot line chart of body/wick percentiles (x = 0..100, y = %) on top of
 * a focused table that lists `p100, p95, ..., p50` for both metrics.
 *
 * Per-year breakdowns are intentionally omitted from the HTML — they live
 * only in the JSON sidecar so the page stays scannable. The JSON is the
 * place to query "what was BTC body p99 in 2024".
 */
export function renderTrainingDistributionsHtml({
  payload,
}: {
  readonly payload: TrainingDistributionsPayload;
}): string {
  const slices = payload.assets.map(toDashboardSlice);
  const seriesLabel = `${payload.series.source}-${payload.series.product} ${payload.series.timeframe}`;
  const generatedAt = new Date(payload.generatedAtMs).toISOString();
  const tableHeaderCells = tableTailPercentiles
    .map((p) => `<th scope="col">p${p}</th>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Training: Candle Size Distributions</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.classless.min.css" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/uplot@1.6.30/dist/uPlot.min.css" />
  <script src="https://cdn.jsdelivr.net/npm/uplot@1.6.30/dist/uPlot.iife.min.js" charset="utf-8"></script>
  <style>
    /* Pico classless gives us typography, color tokens, and table styling
       for free; this block only overrides the layout (full-viewport
       dashboard, not Pico's centered document) and styles the bits Pico
       does not know about (tabs, chart host, the percentile-table tail). */
    :root { color-scheme: light; --pico-font-size: 87.5%; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; padding: 0; }
    body > header { padding: 18px 28px 14px; max-width: none; border-bottom: 1px solid var(--pico-muted-border-color); flex: 0 0 auto; }
    body > header > h1 { font-size: 18px; margin: 0; --pico-typography-spacing-vertical: 0; }
    body > header > p { margin: 6px 0 0; color: var(--pico-muted-color); font-variant-numeric: tabular-nums; --pico-typography-spacing-vertical: 0; }
    body > main { flex: 1 1 auto; max-width: none; padding: 14px 28px 32px; display: flex; flex-direction: column; gap: 18px; }
    nav.tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--pico-muted-border-color); padding: 0; margin: 0; flex-wrap: wrap; }
    nav.tabs .tab {
      background: transparent; border: none; border-bottom: 2px solid transparent;
      padding: 8px 16px; cursor: pointer; border-radius: 0;
      width: auto; margin: 0 0 -1px 0; line-height: 1.4;
      color: var(--pico-muted-color); font-weight: 500; font-size: 14px;
      letter-spacing: 0.02em; text-transform: uppercase;
      --pico-background-color: transparent;
    }
    nav.tabs .tab:hover { color: var(--pico-color); }
    nav.tabs .tab.active { color: var(--pico-color); border-bottom-color: ${bodyColor}; font-weight: 600; }
    section.asset { display: flex; flex-direction: column; gap: 18px; }
    section.asset > header { display: flex; align-items: baseline; gap: 14px; }
    section.asset > header > h2 { margin: 0; font-size: 16px; --pico-typography-spacing-vertical: 0; }
    section.asset > header > p { margin: 0; color: var(--pico-muted-color); font-size: 13px; font-variant-numeric: tabular-nums; --pico-typography-spacing-vertical: 0; }
    .chart-card { display: flex; flex-direction: column; gap: 8px; }
    .chart-card .legend { display: flex; gap: 18px; font-size: 13px; color: var(--pico-color); }
    .chart-card .legend .swatch { display: inline-block; width: 22px; height: 2px; vertical-align: middle; margin-right: 8px; }
    .chart-host { position: relative; width: 100%; height: 360px; }
    .table-wrap { overflow-x: auto; }
    table.percentiles { width: 100%; min-width: 720px; margin: 0; --pico-typography-spacing-vertical: 0; font-variant-numeric: tabular-nums; }
    table.percentiles thead th { color: var(--pico-muted-color); font-weight: 500; text-align: right; }
    table.percentiles tbody th { text-align: left; text-transform: uppercase; letter-spacing: 0.04em; font-size: 13px; }
    table.percentiles tbody td { text-align: right; }
    table.percentiles tbody tr.body th { color: ${bodyColor}; }
    table.percentiles tbody tr.wick th { color: ${wickColor}; }
    .uplot, .u-wrap { background: transparent; }
    .u-legend { display: none !important; }
  </style>
</head>
<body>
  <header>
    <h1>Training · Candle Size Distributions</h1>
    <p>${escapeHtml(seriesLabel)} · generated ${escapeHtml(generatedAt)}</p>
  </header>
  <main>
    <nav class="tabs" role="tablist" id="tabs">
      ${slices
        .map(
          (slice, idx) =>
            `<button type="button" role="tab" class="tab${idx === 0 ? " active" : ""}" data-asset="${escapeHtml(slice.asset)}">${escapeHtml(slice.assetUpper)}</button>`,
        )
        .join("\n      ")}
    </nav>
    <section class="asset" id="asset-panel">
      <header>
        <h2 id="asset-title"></h2>
        <p id="asset-meta"></p>
      </header>
      <div class="chart-card">
        <div class="legend">
          <span><span class="swatch" style="background:${bodyColor}"></span>body — |close − open| / open</span>
          <span><span class="swatch" style="background:${wickColor}"></span>wick — (high − low) / open</span>
        </div>
        <div id="chart" class="chart-host"></div>
      </div>
      <div class="table-wrap">
        <table class="percentiles">
          <thead>
            <tr>
              <th scope="col"></th>
              ${tableHeaderCells}
            </tr>
          </thead>
          <tbody>
            <tr class="body"><th scope="row">body</th><td colspan="${tableTailPercentiles.length}" id="body-row"></td></tr>
            <tr class="wick"><th scope="row">wick</th><td colspan="${tableTailPercentiles.length}" id="wick-row"></td></tr>
          </tbody>
        </table>
      </div>
    </section>
  </main>
  <script>
    const slices = ${JSON.stringify(slices)};
    const tablePs = ${JSON.stringify(tableTailPercentiles)};
    const xs = Array.from({ length: 101 }, (_, i) => i);
    const bodyColor = ${JSON.stringify(bodyColor)};
    const wickColor = ${JSON.stringify(wickColor)};

    const formatPct = (v) => {
      if (v == null || !Number.isFinite(v)) return "—";
      if (v >= 10) return v.toFixed(1) + "%";
      if (v >= 1) return v.toFixed(2) + "%";
      if (v >= 0.1) return v.toFixed(3) + "%";
      return v.toFixed(4) + "%";
    };

    const tabsEl = document.getElementById("tabs");
    const titleEl = document.getElementById("asset-title");
    const metaEl = document.getElementById("asset-meta");
    const chartHost = document.getElementById("chart");
    let chart = null;

    function renderTable(slice) {
      const bodyRow = document.getElementById("body-row");
      const wickRow = document.getElementById("wick-row");
      bodyRow.parentElement.innerHTML = '<th scope="row">body</th>'
        + tablePs.map((p) => '<td>' + formatPct(slice.body[p]) + '</td>').join("");
      wickRow.parentElement.innerHTML = '<th scope="row">wick</th>'
        + tablePs.map((p) => '<td>' + formatPct(slice.wick[p]) + '</td>').join("");
    }

    function renderChart(slice) {
      if (chart) { chart.destroy(); chart = null; }
      const data = [xs, slice.body, slice.wick];
      const opts = {
        width: chartHost.clientWidth,
        height: chartHost.clientHeight,
        padding: [12, 24, 8, 8],
        cursor: { points: { show: true }, drag: { setScale: false } },
        legend: { show: false },
        scales: { x: { time: false } },
        series: [
          {},
          { label: "body", stroke: bodyColor, width: 1.75, points: { show: false } },
          { label: "wick", stroke: wickColor, width: 1.75, points: { show: false } },
        ],
        axes: [
          {
            stroke: "#64748b",
            grid: { stroke: "#f1f5f9", width: 1 },
            ticks: { stroke: "#cbd5e1", width: 1, size: 6 },
            font: "13px -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
            values: (u, splits) => splits.map((p) => "p" + Math.round(p)),
            space: 60,
          },
          {
            stroke: "#64748b",
            grid: { stroke: "#f1f5f9", width: 1 },
            ticks: { show: false },
            font: "13px -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
            values: (u, splits) => splits.map(formatPct),
            size: 80,
          },
        ],
      };
      chart = new uPlot(opts, data, chartHost);
    }

    function activate(asset) {
      const slice = slices.find((s) => s.asset === asset);
      if (!slice) return;
      for (const btn of tabsEl.querySelectorAll(".tab")) {
        btn.classList.toggle("active", btn.getAttribute("data-asset") === asset);
      }
      titleEl.textContent = slice.assetUpper;
      const yearStr = slice.yearRange ? slice.yearRange + " · " : "";
      metaEl.textContent = yearStr + slice.candleCount.toLocaleString() + " candles";
      renderTable(slice);
      renderChart(slice);
    }

    tabsEl.addEventListener("click", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const btn = target.closest(".tab");
      if (!btn) return;
      const asset = btn.getAttribute("data-asset");
      if (asset) activate(asset);
    });

    window.addEventListener("resize", () => {
      if (chart) chart.setSize({ width: chartHost.clientWidth, height: chartHost.clientHeight });
    });

    if (slices.length > 0) activate(slices[0].asset);
  </script>
</body>
</html>
`;
}

function toDashboardSlice(asset: AssetSizeDistribution): DashboardAssetSlice {
  const years = Object.keys(asset.byYear).sort();
  const first = years[0];
  const last = years[years.length - 1];
  const yearRange =
    first !== undefined && last !== undefined
      ? first === last
        ? first
        : `${first}–${last}`
      : null;
  return {
    asset: asset.asset,
    assetUpper: asset.asset.toUpperCase(),
    candleCount: asset.candleCount,
    yearRange,
    body: asset.all.body,
    wick: asset.all.wick,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
