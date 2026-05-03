import type {
  AssetSizeDistribution,
  TrainingDistributionsPayload,
} from "@alea/lib/training/types";
import {
  aleaBrandMark,
  aleaChartTokens,
  aleaDesignSystemHead,
} from "@alea/lib/ui/aleaDesignSystem";

/**
 * Body = "the move" (close minus open); wick = "the envelope" (high minus
 * low). Colors are pulled from the shared design tokens so they stay in
 * lockstep with any tooltip/legend swatches the design system renders.
 */
const bodyColor = aleaChartTokens.bodyColor;
const wickColor = aleaChartTokens.wickColor;

/**
 * Percentiles to render in the upper-tail table. Chart shows all 101 points
 * regardless; the table is a focused readout of the right half of the
 * distribution where threshold decisions get made.
 */
const tableTailPercentiles: readonly number[] = [
  95, 90, 85, 80, 75, 70, 65, 60, 55, 50,
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
 * Renders a self-contained dark-themed HTML dashboard for the
 * `training:distributions` analysis. One tab per asset; each tab has a
 * uPlot CDF chart of body/wick percentiles (x = move size in bp, y =
 * P(move <= x), in %) above a focused table that lists `p95...p50` for
 * both metrics.
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
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Alea · Training · Candle Size Distributions</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/uplot@1.6.30/dist/uPlot.min.css" />
  <script src="https://cdn.jsdelivr.net/npm/uplot@1.6.30/dist/uPlot.iife.min.js" charset="utf-8"></script>
  ${aleaDesignSystemHead()}
  <style>
    /* Page-specific layout: the asset panel composition, the chart-host
       sizing, and a few percentile-table tweaks (sticky-ish first column,
       per-series row label colors). Tokens, fonts, cards, tabs, generic
       table styling, and tooltip chrome all come from the design system. */
    .asset-panel { display: flex; flex-direction: column; gap: 18px; }

    .chart-section { display: flex; flex-direction: column; gap: 14px; }

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
      height: 380px;
      min-height: 380px;
      max-height: 380px;
    }

    .chart-loading {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--alea-text-subtle);
      font-size: 12.5px;
      letter-spacing: 0.04em;
    }

    .chart-error {
      color: var(--alea-red);
      font-family: var(--alea-font-mono);
      padding: 12px;
      margin: 0;
      white-space: pre-wrap;
      font-size: 12px;
    }

    /* Percentile table: dense numeric layout. Min-width keeps the columns
       readable on narrow viewports (the wrap scrolls horizontally). */
    table.percentiles { min-width: 970px; table-layout: fixed; }
    table.percentiles th:first-child,
    table.percentiles td:first-child { width: 90px; }
    table.percentiles th, table.percentiles td { white-space: nowrap; }
    table.percentiles tbody tr.body th { color: ${bodyColor}; }
    table.percentiles tbody tr.wick th { color: ${wickColor}; }

    /* Push the candle-count meta to the right edge of the card header. */
    .alea-card-meta-end { margin-left: auto; }

    /* Numeric cells use the display serif; gives the readout a slight
       ledger feel without sacrificing tabular-nums alignment. */
    table.percentiles tbody td {
      font-family: var(--alea-font-display);
      font-weight: 500;
      font-size: 16px;
      letter-spacing: 0.01em;
      color: var(--alea-text);
    }
  </style>
</head>
<body>
  <div class="alea-shell">
    <header class="alea-header">
      <div class="alea-brand-row">${aleaBrandMark()}</div>
      <h1 class="alea-title">Training · Candle Size Distributions</h1>
      <p class="alea-subtitle">${escapeHtml(seriesLabel)}<span class="sep">·</span>generated ${escapeHtml(generatedAt)}</p>
    </header>
    <main class="alea-main">
      <nav class="alea-tabs" role="tablist" id="tabs">
        ${slices
          .map(
            (slice, idx) =>
              `<button type="button" role="tab" class="alea-tab${idx === 0 ? " active" : ""}" data-asset="${escapeHtml(slice.asset)}">${escapeHtml(slice.assetUpper)}</button>`,
          )
          .join("\n        ")}
      </nav>
      <section class="alea-card with-corners asset-panel" id="asset-panel">
        <header class="alea-card-header">
          <h2 class="alea-card-title" id="asset-title"></h2>
          <p class="alea-card-meta" id="asset-meta"></p>
          <p class="alea-card-meta alea-card-meta-end" id="asset-count"></p>
        </header>
        <div class="chart-section">
          <div class="alea-legend">
            <span class="alea-legend-item"><span class="alea-legend-swatch" style="background:${bodyColor}"></span>body size</span>
            <span class="alea-legend-item"><span class="alea-legend-swatch" style="background:${wickColor}"></span>wick size</span>
          </div>
          <div class="chart-frame">
            <div id="chart" class="chart-host"><div class="chart-loading">Loading chart…</div></div>
            <div id="chart-tooltip" class="alea-tooltip"></div>
          </div>
        </div>
        <div class="alea-table-wrap">
          <table class="alea-table percentiles">
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
  </div>
  <script>
    const slices = ${JSON.stringify(slices)};
    const tablePs = ${JSON.stringify(tableTailPercentiles)};
    // Chart is a CDF: x = move size in bp, y = P(move <= x), in %. p100
    // is a near-vertical spike (one flash-crash bar) that pushes the
    // x-axis way out and crushes the rest of the curve, so the chart
    // stops at p99. The table still includes p100.
    const chartLastP = 99;
    const bodyColor = ${JSON.stringify(bodyColor)};
    const wickColor = ${JSON.stringify(wickColor)};
    const chartTokens = ${JSON.stringify(aleaChartTokens)};

    // Source values are in percent (e.g. 0.05 = 0.05%). Display in basis
    // points: 1% = 100 bp, rounded to the nearest integer. Same numbers,
    // just a tidier unit for the sub-1% range we care about.
    const formatBips = (v) => {
      if (v == null || !Number.isFinite(v)) return "—";
      return Math.round(v * 100).toLocaleString() + " bp";
    };
    // Probability axis. y values are percentile-indices in [0, 99], so
    // they read directly as percentages.
    const formatProb = (v) => {
      if (v == null || !Number.isFinite(v)) return "—";
      return Math.round(v) + "%";
    };

    const tabsEl = document.getElementById("tabs");
    const titleEl = document.getElementById("asset-title");
    const metaEl = document.getElementById("asset-meta");
    const countEl = document.getElementById("asset-count");
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
        .map((p) => '<td>' + formatBips(slice[key][p]) + '</td>')
        .join("");
      tbodyEl.innerHTML =
        '<tr class="body"><th scope="row">body</th>' + cells("body") + '</tr>' +
        '<tr class="wick"><th scope="row">wick</th>' + cells("wick") + '</tr>';
    }

    function chartHostError(msg) {
      chartHost.innerHTML = '<pre class="chart-error">' + msg + '</pre>';
    }

    // Render synchronously: this script runs at end of <body>, layout has
    // happened, and .chart-host has min-height: 380px so it always has a
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
      const h = chartHost.clientHeight || 380;
      if (w === 0 || h === 0) {
        chartHostError("chart host has zero size: " + w + "x" + h);
        return;
      }
      // Each (percentile, value) pair is a point on the CDF: at x = the
      // p-th percentile move, F(x) = p%. Body and wick have different
      // x-ranges, but uPlot requires a shared x-axis across series — so
      // we merge their x-values into a single sorted array and look up
      // each series' percentile at every shared x via cdfAt(). The
      // result is a staircase ECDF; uPlot draws it as straight segments
      // between the data points, which is fine at 100 points per series.
      const bodyPts = [];
      const wickPts = [];
      for (let p = 0; p <= chartLastP; p++) {
        if (Number.isFinite(slice.body[p])) bodyPts.push([slice.body[p], p]);
        if (Number.isFinite(slice.wick[p])) wickPts.push([slice.wick[p], p]);
      }
      bodyPts.sort((a, b) => a[0] - b[0]);
      wickPts.sort((a, b) => a[0] - b[0]);
      const xsSet = new Set();
      for (const pt of bodyPts) xsSet.add(pt[0]);
      for (const pt of wickPts) xsSet.add(pt[0]);
      const xs = [...xsSet].sort((a, b) => a - b);
      // Largest p where pts[i].x <= x. Returns null if x precedes the
      // series' minimum (the curve hasn't started yet at that x).
      const cdfAt = (pts, x) => {
        let lo = 0, hi = pts.length - 1, ans = null;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (pts[mid][0] <= x) { ans = pts[mid][1]; lo = mid + 1; }
          else hi = mid - 1;
        }
        return ans;
      };
      const bodyData = xs.map((x) => cdfAt(bodyPts, x));
      const wickData = xs.map((x) => cdfAt(wickPts, x));
      const data = [xs.slice(), bodyData, wickData];
      const updateTooltip = (u) => {
        const idx = u.cursor.idx;
        if (idx == null || idx < 0 || idx >= xs.length) {
          tooltipEl.classList.remove("visible");
          return;
        }
        const x = xs[idx];
        const bodyV = bodyData[idx];
        const wickV = wickData[idx];
        tooltipEl.innerHTML =
          '<div class="alea-tooltip-head">' + formatBips(x) + ' or less</div>' +
          '<div class="alea-tooltip-row"><span class="alea-legend-swatch" style="background:' + bodyColor + '"></span><span class="name">body</span><span class="value">' + formatProb(bodyV) + '</span></div>' +
          '<div class="alea-tooltip-row"><span class="alea-legend-swatch" style="background:' + wickColor + '"></span><span class="name">wick</span><span class="value">' + formatProb(wickV) + '</span></div>';
        const cursorLeft = u.cursor.left;
        const frameW = chartFrame.getBoundingClientRect().width;
        const tooltipW = tooltipEl.offsetWidth || 200;
        const margin = 14;
        const placeRight = cursorLeft + margin + tooltipW <= frameW;
        const left = placeRight ? cursorLeft + margin : cursorLeft - margin - tooltipW;
        tooltipEl.style.left = Math.max(margin, Math.min(left, frameW - tooltipW - margin)) + "px";
        tooltipEl.style.top = "14px";
        tooltipEl.classList.add("visible");
      };
      const opts = {
        width: w,
        height: h,
        legend: { show: false },
        padding: [16, 18, 8, 8],
        scales: { x: { time: false } },
        cursor: {
          points: { show: false },
          drag: { setScale: false, x: false, y: false },
        },
        series: [
          {},
          { label: "body", stroke: bodyColor, width: 2 },
          { label: "wick", stroke: wickColor, width: 2 },
        ],
        axes: [
          {
            stroke: chartTokens.axisStroke,
            font: chartTokens.axisFont,
            grid: { stroke: chartTokens.gridStroke, width: 1 },
            ticks: { stroke: chartTokens.axisTickStroke, width: 1, size: 5 },
            values: (u, splits) => splits.map(formatBips),
          },
          {
            stroke: chartTokens.axisStroke,
            font: chartTokens.axisFont,
            grid: { stroke: chartTokens.gridStroke, width: 1 },
            ticks: { stroke: chartTokens.axisTickStroke, width: 1, size: 5 },
            values: (u, splits) => splits.map(formatProb),
            size: 60,
          },
        ],
        hooks: {
          setCursor: [updateTooltip],
          // Faint horizontal reference at P=50%. Drawn in the drawAxes
          // hook so it sits behind the body/wick curves, not over them.
          drawAxes: [
            (u) => {
              const yPos = u.valToPos(50, "y", true);
              const ctx = u.ctx;
              ctx.save();
              ctx.strokeStyle = chartTokens.referenceLine;
              ctx.lineWidth = 1;
              ctx.setLineDash([4, 4]);
              ctx.beginPath();
              ctx.moveTo(u.bbox.left, yPos);
              ctx.lineTo(u.bbox.left + u.bbox.width, yPos);
              ctx.stroke();
              ctx.restore();
            },
          ],
        },
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
      for (const btn of tabsEl.querySelectorAll(".alea-tab")) {
        btn.classList.toggle("active", btn.getAttribute("data-asset") === asset);
      }
      titleEl.textContent = slice.assetUpper;
      metaEl.textContent = slice.yearRange ?? "";
      countEl.textContent = slice.candleCount.toLocaleString() + " candles";
      renderTable(slice);
      renderChart(slice);
    }

    tabsEl.addEventListener("click", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const btn = target.closest(".alea-tab");
      if (!(btn instanceof HTMLElement)) return;
      const asset = btn.getAttribute("data-asset");
      if (!asset) return;
      activate(asset);
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
