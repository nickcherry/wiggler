import type {
  AssetSizeDistribution,
  TrainingDistributionsPayload,
} from "@alea/lib/training/types";

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
  const generatedAt = formatGeneratedAt(payload.generatedAtMs);
  const tableHeaderCells = tableTailPercentiles
    .map((p) => `<th scope="col">p${p}</th>`)
    .join("");

  return `<!doctype html>
<html lang="en" data-theme="light">
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
    /* Pico styles <button> via CSS variables (--pico-background-color,
       --pico-color, --pico-box-shadow, etc.); for the tab pattern we
       override those variables rather than fight Pico's selectors. */
    nav.tabs .tab {
      --pico-background-color: transparent;
      --pico-border-color: transparent;
      --pico-color: #64748b;
      --pico-box-shadow: none;
      border: none;
      border-bottom: 2px solid transparent;
      border-radius: 0;
      padding: 8px 16px;
      margin: 0 0 -1px 0;
      width: auto;
      line-height: 1.4;
      font-weight: 500;
      font-size: 14px;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      cursor: pointer;
      outline: none;
    }
    nav.tabs .tab:hover,
    nav.tabs .tab:focus,
    nav.tabs .tab:focus-visible,
    nav.tabs .tab:active {
      --pico-background-color: transparent;
      --pico-border-color: transparent;
      --pico-color: #0f172a;
      --pico-box-shadow: none;
      outline: none;
    }
    nav.tabs .tab.active {
      --pico-color: #0f172a;
      border-bottom-color: ${bodyColor};
      font-weight: 600;
    }
    /* Block layout for the asset panel — flex was making the chart-host's
       fixed 360px height ambiguous in some browsers and the chart was
       stretching to fill the parent. Plain block + margin-bottom is
       boringly predictable. */
    section.asset { display: block; }
    section.asset > * + * { margin-top: 18px; }
    section.asset > header { display: flex; align-items: baseline; gap: 14px; }
    section.asset > header > h2 { margin: 0; font-size: 16px; --pico-typography-spacing-vertical: 0; }
    section.asset > header > p { margin: 0; color: var(--pico-muted-color); font-size: 13px; font-variant-numeric: tabular-nums; --pico-typography-spacing-vertical: 0; }
    .chart-card { display: block; }
    .chart-card .legend { display: flex; gap: 18px; font-size: 13px; color: var(--pico-color); margin-bottom: 8px; }
    .chart-card .legend .swatch { display: inline-block; width: 22px; height: 2px; vertical-align: middle; margin-right: 8px; }
    .chart-frame { position: relative; }
    .chart-host { position: relative; width: 100%; height: 360px; min-height: 360px; max-height: 360px; }
    .chart-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--pico-muted-color); font-size: 13px; }
    .chart-tooltip {
      position: absolute;
      pointer-events: none;
      background: #ffffff;
      border: 1px solid var(--pico-muted-border-color);
      border-radius: 6px;
      padding: 8px 10px;
      box-shadow: 0 4px 12px rgba(15, 23, 42, 0.08);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      opacity: 0;
      transition: opacity 0.06s ease;
      z-index: 10;
      min-width: 130px;
    }
    .chart-tooltip.visible { opacity: 1; }
    .chart-tooltip .p { font-weight: 600; margin-bottom: 4px; padding-bottom: 4px; border-bottom: 1px solid var(--pico-muted-border-color); color: #0f172a; }
    .chart-tooltip .row { display: grid; grid-template-columns: 12px auto 1fr; gap: 8px; align-items: center; padding: 1px 0; }
    .chart-tooltip .swatch { width: 10px; height: 2px; }
    .chart-tooltip .name { color: var(--pico-muted-color); }
    .chart-tooltip .val { font-weight: 600; text-align: right; color: #0f172a; }
    .table-wrap { overflow-x: auto; }
    /* Min-width is 70px (label col) + 11 * 90px (percentile cols) = 1060px.
       At narrower viewports the .table-wrap scrolls horizontally. Cells
       set white-space: nowrap so numbers never wrap mid-cell regardless. */
    table.percentiles { width: 100%; min-width: 1060px; margin: 0; --pico-typography-spacing-vertical: 0; font-variant-numeric: tabular-nums; table-layout: fixed; }
    table.percentiles th:first-child, table.percentiles td:first-child { width: 70px; }
    table.percentiles th, table.percentiles td { white-space: nowrap; }
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
          <span><span class="swatch" style="background:${bodyColor}"></span>body size</span>
          <span><span class="swatch" style="background:${wickColor}"></span>wick size</span>
        </div>
        <div class="chart-frame">
          <div id="chart" class="chart-host"><div class="chart-loading">Loading chart…</div></div>
          <div id="chart-tooltip" class="chart-tooltip"></div>
        </div>
      </div>
      <div class="table-wrap">
        <table class="percentiles">
          <thead>
            <tr>
              <th scope="col"></th>
              ${tableHeaderCells}
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </section>
  </main>
  <script>
    const slices = ${JSON.stringify(slices)};
    const tablePs = ${JSON.stringify(tableTailPercentiles)};
    // Chart only renders p0..p99. p100 is a near-vertical spike (one
    // flash-crash bar) that compresses the rest of the curve into a flat
    // line, so we exclude it from the chart. The table still includes it.
    const chartLastP = 99;
    const xs = Array.from({ length: chartLastP + 1 }, (_, i) => i);
    const bodyColor = ${JSON.stringify(bodyColor)};
    const wickColor = ${JSON.stringify(wickColor)};

    const formatPct = (v) => {
      if (v == null || !Number.isFinite(v)) return "—";
      if (v >= 10) return v.toFixed(1) + "%";
      if (v >= 1) return v.toFixed(2) + "%";
      if (v >= 0.1) return v.toFixed(3) + "%";
      return v.toFixed(4) + "%";
    };
    // Fixed-precision formatter for the y-axis only. Variable-precision
    // labels would resize per asset and shift the plot area horizontally
    // when switching tabs. The full-precision formatter is still used in
    // the table and the hover tooltip.
    const formatPctAxis = (v) =>
      Number.isFinite(v) ? v.toFixed(1) + "%" : "—";

    const tabsEl = document.getElementById("tabs");
    const titleEl = document.getElementById("asset-title");
    const metaEl = document.getElementById("asset-meta");
    const chartHost = document.getElementById("chart");
    const tooltipEl = document.getElementById("chart-tooltip");
    const chartFrame = chartHost.parentElement;
    let chart = null;

    // Rewrite the whole tbody on every call. We can't keep stable element
    // references inside the rows (innerHTML replacement on a <tr> would
    // detach any id we set on a child), so the tbody itself is the
    // anchor and we re-emit its rows from scratch each time.
    const tbodyEl = document.querySelector("table.percentiles tbody");
    function renderTable(slice) {
      if (!tbodyEl) return;
      const cells = (key) => tablePs
        .map((p) => '<td>' + formatPct(slice[key][p]) + '</td>')
        .join("");
      tbodyEl.innerHTML =
        '<tr class="body"><th scope="row">body</th>' + cells("body") + '</tr>' +
        '<tr class="wick"><th scope="row">wick</th>' + cells("wick") + '</tr>';
    }

    function chartHostError(msg) {
      chartHost.innerHTML = '<pre style="color:#b91c1c;padding:12px;margin:0;white-space:pre-wrap;font-size:12px">' + msg + '</pre>';
    }

    // Render synchronously: this script runs at end of <body>, layout has
    // happened, and .chart-host has min-height: 360px so it always has a
    // measurable size. We deliberately do NOT use requestAnimationFrame
    // here — RAF is paused when document.visibilityState is "hidden",
    // which silently breaks the chart for any tab opened in the
    // background.
    function renderChart(slice) {
      if (chart) { chart.destroy(); chart = null; }
      chartHost.innerHTML = "";
      if (typeof uPlot === "undefined") {
        chartHostError("uPlot global is undefined — CDN failed to load?");
        return;
      }
      const w = chartHost.clientWidth || chartHost.getBoundingClientRect().width || 800;
      const h = chartHost.clientHeight || 360;
      if (w === 0 || h === 0) {
        chartHostError("chart host has zero size: " + w + "x" + h);
        return;
      }
      const sliceTo = chartLastP + 1;
      const bodyData = Array.from({ length: sliceTo }, (_, p) =>
        Number.isFinite(slice.body[p]) ? slice.body[p] : null,
      );
      const wickData = Array.from({ length: sliceTo }, (_, p) =>
        Number.isFinite(slice.wick[p]) ? slice.wick[p] : null,
      );
      const data = [xs.slice(), bodyData, wickData];
      const updateTooltip = (u) => {
        const idx = u.cursor.idx;
        if (idx == null || idx < 0 || idx >= xs.length) {
          tooltipEl.classList.remove("visible");
          return;
        }
        const p = xs[idx];
        const bodyV = bodyData[idx];
        const wickV = wickData[idx];
        tooltipEl.innerHTML =
          '<div class="p">p' + p + '</div>' +
          '<div class="row"><span class="swatch" style="background:' + bodyColor + '"></span><span class="name">body</span><span class="val">' + formatPct(bodyV) + '</span></div>' +
          '<div class="row"><span class="swatch" style="background:' + wickColor + '"></span><span class="name">wick</span><span class="val">' + formatPct(wickV) + '</span></div>';
        const cursorLeft = u.cursor.left;
        const frameW = chartFrame.getBoundingClientRect().width;
        const tooltipW = tooltipEl.offsetWidth || 140;
        const margin = 12;
        const placeRight = cursorLeft + margin + tooltipW <= frameW;
        const left = placeRight ? cursorLeft + margin : cursorLeft - margin - tooltipW;
        tooltipEl.style.left = Math.max(margin, Math.min(left, frameW - tooltipW - margin)) + "px";
        tooltipEl.style.top = "12px";
        tooltipEl.classList.add("visible");
      };
      const opts = {
        width: w,
        height: h,
        legend: { show: false },
        scales: { x: { time: false } },
        cursor: {
          points: { show: false },
          drag: { setScale: false, x: false, y: false },
        },
        series: [
          {},
          { label: "body", stroke: bodyColor, width: 1.75 },
          { label: "wick", stroke: wickColor, width: 1.75 },
        ],
        axes: [
          {
            stroke: "#64748b",
            grid: { show: false },
            ticks: { show: false },
            values: (u, splits) => splits.map((p) => "p" + Math.round(p)),
          },
          {
            stroke: "#64748b",
            grid: { show: false },
            ticks: { show: false },
            values: (u, splits) => splits.map(formatPctAxis),
            size: 64,
          },
        ],
        hooks: { setCursor: [updateTooltip] },
      };
      try {
        chart = new uPlot(opts, data, chartHost);
        chartHost.addEventListener("mouseleave", () => tooltipEl.classList.remove("visible"));
      } catch (err) {
        chartHostError("uPlot threw: " + (err && err.message ? err.message : String(err)));
      }
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
      if (!(btn instanceof HTMLElement)) return;
      const asset = btn.getAttribute("data-asset");
      if (!asset) return;
      activate(asset);
      // Drop focus so Pico's :focus styling does not stick after click.
      btn.blur();
    });

    // Use a ResizeObserver so the chart tracks its container even when
    // window size is unchanged (e.g. flex-layout reflow on first paint).
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => {
        if (!chart) return;
        const w = chartHost.clientWidth;
        const h = chartHost.clientHeight;
        if (w > 0 && h > 0) chart.setSize({ width: w, height: h });
      });
      ro.observe(chartHost);
    }
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

/**
 * Formats the run timestamp as `YYYY-MM-DD @ HH:MM` in the local timezone
 * of the machine that ran the CLI. No timezone label — the operator opens
 * the HTML on their own clock and doesn't need a reminder.
 */
function formatGeneratedAt(ms: number): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(ms));
  const get = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} @ ${get("hour")}:${get("minute")}`;
}
