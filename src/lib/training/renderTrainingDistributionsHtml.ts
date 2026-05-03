import type {
  AssetSizeDistribution,
  AssetSurvivalDistribution,
  AssetSurvivalFilters,
  SizeHistogram,
  SurvivalFilterResultPayload,
  SurvivalRemainingMinutes,
  SurvivalSurfaceWithCount,
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

/**
 * Minimum snapshot count required for a `(remaining, distance)` survival
 * bucket to be considered trustworthy: rendered as a chart point and
 * eligible to fill a threshold-table cell. Buckets below this floor are
 * hidden from the chart and shown as "—" in the table. 500 is conservative
 * enough given a few years of 1m candles (~100k+ snapshots per
 * remaining-minutes bucket per asset) without hiding too much useful data.
 */
const SURVIVAL_MIN_SAMPLES = 500;

/**
 * x-axis range for the survival chart, in basis points. Matches the upper
 * end of the body/wick CDF so the two charts read at the same visual
 * scale.
 */
const SURVIVAL_MAX_DISTANCE_BP = 75;

/**
 * Target win rates (percent) for the threshold-table columns. Each cell
 * is the minimum distance bucket whose win rate meets/exceeds the target
 * while also clearing `SURVIVAL_MIN_SAMPLES`.
 */
const SURVIVAL_TARGET_WIN_RATES: readonly number[] = [
  60, 65, 70, 75, 80, 85, 90, 95,
];

/**
 * Color per remaining-minutes line. Cooler/blue for 4m-left (far from
 * settlement, where survival is hardest to call) → warmer/gold for 1m-left
 * (sharp "point of no return"). Matches the visual intuition that less
 * time = more decisive curve.
 */
const SURVIVAL_REMAINING_COLORS: Readonly<
  Record<SurvivalRemainingMinutes, string>
> = {
  4: "#5b95ff",
  3: "#46c37b",
  2: "#ffa566",
  1: "#d7aa45",
};

/**
 * Order in which the remaining-minutes lines are stacked in the chart's
 * series array, the legend, and the table rows. Chart series are drawn
 * later-on-top, so 1m-left (the most decisive curve) ends up on top.
 */
const SURVIVAL_REMAINING_ORDER: readonly SurvivalRemainingMinutes[] = [
  4, 3, 2, 1,
];

/**
 * Three-way color scheme for filter mini-charts. Baseline is muted ivory
 * (the reference everyone reads against). True/false leaning on the
 * existing green/red semantics — green = aligned/positive, red = against.
 * Same hues used in the table delta arrows.
 */
const FILTER_COLORS = {
  baseline: "#b8aa8a",
  whenTrue: "#46c37b",
  whenFalse: "#d85a4f",
} as const;

type DashboardAssetSlice = {
  readonly asset: string;
  readonly assetUpper: string;
  readonly candleCount: number;
  readonly yearRange: string | null;
  readonly body: readonly number[];
  readonly wick: readonly number[];
  readonly histogram: SizeHistogram;
  readonly survival: SurvivalSlice | null;
  readonly filters: readonly FilterSlice[];
};

/**
 * Chart-ready data for one filter section. Three densified surfaces
 * (baseline / whenTrue / whenFalse) sharing the same `distancesBp`
 * x-axis. The filter table reads the same `winRate` arrays plus the
 * pre-computed thresholds for delta arrows. `summary` powers the
 * per-section header line above the chart grid.
 */
type FilterSlice = {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly trueLabel: string;
  readonly falseLabel: string;
  readonly distancesBp: readonly number[];
  readonly baseline: FilterSurfaceArrays;
  readonly whenTrue: FilterSurfaceArrays;
  readonly whenFalse: FilterSurfaceArrays;
  /**
   * Threshold matrix per surface — minimum distance (bp) at which the
   * surface's win rate first meets each target win rate, subject to the
   * sample-count floor. `null` for "never reaches", `"thin"` for
   * "below sample-count floor everywhere within range". Indexed by
   * remaining minutes → target → cell value.
   */
  readonly thresholds: {
    readonly baseline: ThresholdMatrixSerialized;
    readonly whenTrue: ThresholdMatrixSerialized;
    readonly whenFalse: ThresholdMatrixSerialized;
  };
  readonly summary: {
    readonly snapshotsTrue: number;
    readonly snapshotsFalse: number;
    readonly snapshotsSkipped: number;
    readonly occurrenceTrue: number;
    readonly occurrenceFalse: number;
    readonly bestImprovementBpTrue: number | null;
    readonly bestImprovementBpFalse: number | null;
  };
};

type FilterSurfaceArrays = Readonly<
  Record<
    SurvivalRemainingMinutes,
    {
      readonly winRate: readonly (number | null)[];
      readonly sampleCount: readonly number[];
    }
  >
>;

type ThresholdCell = number | null | "thin";

type ThresholdMatrixSerialized = Readonly<
  Record<SurvivalRemainingMinutes, readonly ThresholdCell[]>
>;

/**
 * Chart-ready survival data. `distancesBp` is the shared x-axis (every
 * integer bp from 0 to `SURVIVAL_MAX_DISTANCE_BP - 1`). For each remaining
 * bucket we carry parallel arrays:
 *
 *   - `winRate[i]` ∈ [0, 100] or `null` when the bucket is empty/sparse
 *     (below `SURVIVAL_MIN_SAMPLES`). uPlot draws nulls as gaps.
 *   - `sampleCount[i]` is the raw bucket size (always present, even when
 *     below the floor — used in tooltips so the operator can see why a
 *     point was hidden).
 *
 * `windowCount` powers the per-section header.
 */
type SurvivalSlice = {
  readonly windowCount: number;
  readonly distancesBp: readonly number[];
  readonly byRemaining: Readonly<
    Record<
      SurvivalRemainingMinutes,
      {
        readonly winRate: readonly (number | null)[];
        readonly sampleCount: readonly number[];
      }
    >
  >;
};

/**
 * Renders a self-contained dark-themed HTML dashboard for the
 * `training:distributions` analysis. One tab per asset; each tab has a
 * uPlot histogram of body/wick sizes (x = move size in bp, y = % of
 * candles in that bin) above a focused table that lists `p95...p50` for
 * both metrics. The chart is for shape intuition; the table is the place
 * to read off thresholds.
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
  const survivalByAsset = new Map<string, AssetSurvivalDistribution>();
  for (const survival of payload.survival) {
    survivalByAsset.set(survival.asset, survival);
  }
  const filtersByAsset = new Map<string, AssetSurvivalFilters>();
  for (const filterBundle of payload.survivalFilters) {
    filtersByAsset.set(filterBundle.asset, filterBundle);
  }
  const slices = payload.assets.map((asset) =>
    toDashboardSlice({
      asset,
      survival: survivalByAsset.get(asset.asset) ?? null,
      filters: filtersByAsset.get(asset.asset) ?? null,
    }),
  );
  const seriesLabel = `${payload.series.source}-${payload.series.product} ${payload.series.timeframe}`;
  const generatedAt = formatGeneratedAt(payload.generatedAtMs);
  const tableHeaderCells = tableTailPercentiles
    .map((p) => `<th scope="col">p${p}</th>`)
    .join("");
  const survivalTableHeaderCells = SURVIVAL_TARGET_WIN_RATES.map(
    (rate) => `<th scope="col">${rate}%</th>`,
  ).join("");
  const survivalLegendItems = SURVIVAL_REMAINING_ORDER.map(
    (rem) =>
      `<span class="alea-legend-item"><span class="alea-legend-swatch" style="background:${SURVIVAL_REMAINING_COLORS[rem]}"></span>${rem}m left</span>`,
  ).join("");

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

    /* Survival section: a second chart + table inside the same asset
       panel. Spacing matches the body/wick block above so the two read as
       siblings rather than a new card. */
    .survival-section { display: flex; flex-direction: column; gap: 14px; }

    .survival-helper {
      margin: 0;
      color: var(--alea-text-muted);
      font-size: 12.5px;
      line-height: 1.5;
      max-width: 760px;
    }

    .survival-empty {
      margin: 0;
      padding: 24px;
      color: var(--alea-text-subtle);
      font-size: 13px;
      text-align: center;
      border: 1px dashed var(--alea-border-muted);
      border-radius: 10px;
      background: rgba(15, 22, 16, 0.4);
    }

    /* Threshold table styling — matches the percentile table conventions
       but its own min-width since the column count is different. */
    table.survival-thresholds { min-width: 760px; table-layout: fixed; }
    table.survival-thresholds th:first-child,
    table.survival-thresholds td:first-child { width: 110px; }
    table.survival-thresholds th, table.survival-thresholds td { white-space: nowrap; }
    table.survival-thresholds tbody td {
      font-family: var(--alea-font-display);
      font-weight: 500;
      font-size: 16px;
      letter-spacing: 0.01em;
      color: var(--alea-text);
    }
    table.survival-thresholds tbody td.empty {
      color: var(--alea-text-subtle);
      font-family: var(--alea-font-sans);
      font-weight: 400;
      font-size: 14px;
    }

    /* Filter overlay sections — one per binary filter, rendered below the
       baseline survival section. Same visual language as the survival
       section but with small-multiples charts (one per remaining-minutes
       bucket) and a 12-row threshold table that includes deltas vs
       baseline. */
    .filter-sections-host { display: flex; flex-direction: column; gap: 32px; }

    .filter-section { display: flex; flex-direction: column; gap: 14px; }

    .filter-summary-line {
      margin: 0;
      color: var(--alea-text-muted);
      font-size: 12.5px;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.02em;
    }

    .filter-summary-line .filter-summary-pill {
      display: inline-block;
      margin-right: 14px;
    }

    .filter-summary-line .filter-summary-key {
      color: var(--alea-text-subtle);
      margin-right: 6px;
    }

    .filter-summary-line .filter-summary-value {
      color: var(--alea-text);
      font-weight: 500;
    }

    .filter-summary-line .filter-summary-good { color: var(--alea-green); }
    .filter-summary-line .filter-summary-bad { color: var(--alea-red); }

    .filter-chart-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
    }

    @media (max-width: 1080px) {
      .filter-chart-grid { grid-template-columns: 1fr; }
    }

    .filter-chart-cell {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .filter-chart-cell-label {
      color: var(--alea-text-muted);
      font-size: 11.5px;
      font-weight: 600;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      padding-left: 4px;
    }

    .filter-chart-cell .chart-host {
      height: 220px;
      min-height: 220px;
      max-height: 220px;
    }

    /* Filter threshold table: same general look as survival-thresholds but
       with grouping borders between remaining-minutes triples and styled
       split rows (baseline ivory, with-filter green tint, against red
       tint). */
    table.filter-thresholds { min-width: 760px; table-layout: fixed; }
    table.filter-thresholds th:first-child,
    table.filter-thresholds td:first-child { width: 200px; }
    table.filter-thresholds th, table.filter-thresholds td { white-space: nowrap; }
    table.filter-thresholds tbody td {
      font-family: var(--alea-font-display);
      font-weight: 500;
      font-size: 15px;
      letter-spacing: 0.01em;
      color: var(--alea-text);
    }
    table.filter-thresholds tbody tr.row-baseline th {
      color: var(--alea-text-muted);
    }
    table.filter-thresholds tbody tr.row-when-true th { color: var(--alea-green); }
    table.filter-thresholds tbody tr.row-when-false th { color: var(--alea-red); }
    table.filter-thresholds tbody tr.row-group-end td,
    table.filter-thresholds tbody tr.row-group-end th {
      border-bottom: 1px solid var(--alea-border-muted);
    }
    table.filter-thresholds tbody td.empty,
    table.filter-thresholds tbody td.thin {
      color: var(--alea-text-subtle);
      font-family: var(--alea-font-sans);
      font-weight: 400;
      font-size: 13px;
    }
    table.filter-thresholds tbody td .delta-good { color: var(--alea-green); margin-left: 6px; font-size: 12.5px; }
    table.filter-thresholds tbody td .delta-bad { color: var(--alea-red); margin-left: 6px; font-size: 12.5px; }
    table.filter-thresholds tbody td .delta-flat { color: var(--alea-text-subtle); margin-left: 6px; font-size: 12.5px; }
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

        <div class="alea-section-rule">
          <h2>Point-of-No-Return Levels</h2>
        </div>
        <p class="survival-helper">Minimum distance from the 5m start line needed for the current side to historically survive. Each line shows the empirical win rate at every distance bucket given the time remaining in the window. Baseline only — no volatility, candle-shape, or regime filters are included. Buckets with fewer than ${SURVIVAL_MIN_SAMPLES.toLocaleString()} snapshots are hidden.</p>

        <div class="survival-section" id="survival-section">
          <p class="alea-card-meta" id="survival-meta"></p>
          <div class="alea-legend">
            ${survivalLegendItems}
          </div>
          <div class="chart-frame">
            <div id="survival-chart" class="chart-host"><div class="chart-loading">Loading chart…</div></div>
            <div id="survival-tooltip" class="alea-tooltip"></div>
          </div>
          <div class="alea-table-wrap">
            <table class="alea-table survival-thresholds">
              <thead>
                <tr>
                  <th scope="col"></th>
                  ${survivalTableHeaderCells}
                </tr>
              </thead>
              <tbody id="survival-tbody"></tbody>
            </table>
          </div>
        </div>

        <div class="alea-section-rule">
          <h2>Simple Filter Overlays</h2>
        </div>
        <p class="survival-helper">Each filter splits the same survival snapshots in two, so we can ask "does this slice of context tighten the point of no return?". Mini-charts compare baseline vs filter-true vs filter-false at each remaining-time bucket; the table below shows where each split reaches the same win-rate targets, with deltas from baseline. Lower is better.</p>

        <div class="filter-sections-host" id="filter-sections-host"></div>

        <div class="alea-section-rule">
          <h2>Movement Distribution</h2>
        </div>
        <p class="survival-helper">Distribution of 5m candle body and full high-low range. Useful for understanding normal move size, not directly a survival probability.</p>
        <div class="chart-section">
          <div class="alea-legend">
            <span class="alea-legend-item"><span class="alea-legend-swatch" style="background:${bodyColor}"></span>body</span>
            <span class="alea-legend-item"><span class="alea-legend-swatch" style="background:${wickColor}"></span>range</span>
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
    // Chart is a histogram: x = move size in bp, y = % of candles whose
    // size falls in that 1 bp bin. The bin range is sized to p99 of the
    // larger metric, so anything past it (the rare flash-crash tail) lives
    // in the overflow slot of the histogram payload and isn't plotted —
    // the table still surfaces p100 if you want it.
    const bodyColor = ${JSON.stringify(bodyColor)};
    const wickColor = ${JSON.stringify(wickColor)};
    // Translucent line-color fills for the two histogram series. Computed
    // here (not in the design-system tokens) since the opacity is purely a
    // chart-rendering choice — same hue as the stroke, dim enough that two
    // overlapping series stay readable.
    const bodyFill = "rgba(91, 149, 255, 0.18)";
    const wickFill = "rgba(255, 165, 102, 0.18)";
    const chartTokens = ${JSON.stringify(aleaChartTokens)};
    const survivalRemainingOrder = ${JSON.stringify(SURVIVAL_REMAINING_ORDER)};
    const survivalRemainingColors = ${JSON.stringify(SURVIVAL_REMAINING_COLORS)};
    const survivalTargetWinRates = ${JSON.stringify(SURVIVAL_TARGET_WIN_RATES)};
    const survivalMinSamples = ${SURVIVAL_MIN_SAMPLES};

    // Source values are in percent (e.g. 0.05 = 0.05%). Display in basis
    // points: 1% = 100 bp, rounded to the nearest integer. Same numbers,
    // just a tidier unit for the sub-1% range we care about.
    const formatBips = (v) => {
      if (v == null || !Number.isFinite(v)) return "—";
      return Math.round(v * 100).toLocaleString() + " bp";
    };
    // Table cells are CDF readouts ("p95 = ≤ N bp" reads as "95% of
    // candles are at or below N bp"), so prefix the bp value with ≤. The
    // null/non-finite path drops the prefix — "≤ —" looks broken.
    const formatBipsCdf = (v) => {
      if (v == null || !Number.isFinite(v)) return "—";
      return "≤ " + Math.round(v * 100).toLocaleString() + " bp";
    };
    // Histogram density axis: bin counts normalized to % of all candles.
    // Typical heights are in the 0.1–5% range so two decimal places gives
    // the tooltip useful resolution without going to noise.
    const formatDensity = (v) => {
      if (v == null || !Number.isFinite(v)) return "—";
      return v.toFixed(2) + "%";
    };

    const tabsEl = document.getElementById("tabs");
    const titleEl = document.getElementById("asset-title");
    const metaEl = document.getElementById("asset-meta");
    const countEl = document.getElementById("asset-count");
    const chartHost = document.getElementById("chart");
    const tooltipEl = document.getElementById("chart-tooltip");
    const chartFrame = chartHost.parentElement;
    let chart = null;

    const survivalSectionEl = document.getElementById("survival-section");
    const survivalMetaEl = document.getElementById("survival-meta");
    const survivalChartHost = document.getElementById("survival-chart");
    const survivalTooltipEl = document.getElementById("survival-tooltip");
    const survivalChartFrame = survivalChartHost.parentElement;
    const survivalTbodyEl = document.getElementById("survival-tbody");
    let survivalChart = null;

    // Rewrite the whole tbody on every call. We can't keep stable element
    // references inside the rows (innerHTML replacement on a <tr> would
    // detach any id we set on a child), so the tbody itself is the
    // anchor and we re-emit its rows from scratch each time.
    const tbodyEl = document.querySelector("table.percentiles tbody");
    function renderTable(slice) {
      if (!tbodyEl) return;
      const cells = (key) => tablePs
        .map((p) => '<td>' + formatBipsCdf(slice[key][p]) + '</td>')
        .join("");
      tbodyEl.innerHTML =
        '<tr class="body"><th scope="row">body</th>' + cells("body") + '</tr>' +
        '<tr class="wick"><th scope="row">range</th>' + cells("wick") + '</tr>';
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
      // Histogram payload: bin i covers [i*binWidth, (i+1)*binWidth) in
      // percent-of-open units; the trailing slot at index binCount is the
      // overflow tail (everything past p99) and is intentionally not
      // plotted. Convert bin width to bp for axis labels and divide each
      // bin count by total candles to get density (% of candles per bin).
      const hist = slice.histogram;
      const total = slice.candleCount;
      const binWidthBp = hist.binWidth * 100;
      // x = bin starts in bp, with one extra "closer" point at the right
      // edge of the last bin so uPlot's stepped path renders the trailing
      // bar with its full width. The closer's y is null so the path ends
      // there cleanly.
      const xs = new Array(hist.binCount + 1);
      for (let i = 0; i <= hist.binCount; i++) xs[i] = i * binWidthBp;
      const toDensity = (counts) => {
        const out = new Array(hist.binCount + 1);
        for (let i = 0; i < hist.binCount; i++) {
          out[i] = total > 0 ? (counts[i] / total) * 100 : 0;
        }
        out[hist.binCount] = null;
        return out;
      };
      const bodyData = toDensity(hist.body);
      const wickData = toDensity(hist.wick);
      const data = [xs, bodyData, wickData];
      const updateTooltip = (u) => {
        const idx = u.cursor.idx;
        // The trailing closer (idx === binCount) is a structural point,
        // not a real bin — suppress the tooltip there.
        if (idx == null || idx < 0 || idx >= hist.binCount) {
          tooltipEl.classList.remove("visible");
          return;
        }
        const xStart = xs[idx];
        const xEnd = xs[idx + 1];
        const bodyV = bodyData[idx];
        const wickV = wickData[idx];
        const range = Math.round(xStart).toLocaleString() + '–' + Math.round(xEnd).toLocaleString() + ' bp';
        tooltipEl.innerHTML =
          '<div class="alea-tooltip-head">' + range + '</div>' +
          '<div class="alea-tooltip-row"><span class="alea-legend-swatch" style="background:' + bodyColor + '"></span><span class="name">body</span><span class="value">' + formatDensity(bodyV) + '</span></div>' +
          '<div class="alea-tooltip-row"><span class="alea-legend-swatch" style="background:' + wickColor + '"></span><span class="name">range</span><span class="value">' + formatDensity(wickV) + '</span></div>';
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
      // Stepped path with align: 1 means "the value at x[i] holds until
      // x[i+1]" — exactly the histogram semantics: a flat top across each
      // bin's [start, end) range. The translucent fill underneath gives the
      // shape a density feel without obscuring the other series.
      const steppedPath = uPlot.paths.stepped({ align: 1 });
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
          {
            label: "body",
            stroke: bodyColor,
            fill: bodyFill,
            width: 1.5,
            paths: steppedPath,
            points: { show: false },
          },
          {
            label: "wick",
            stroke: wickColor,
            fill: wickFill,
            width: 1.5,
            paths: steppedPath,
            points: { show: false },
          },
        ],
        axes: [
          {
            stroke: chartTokens.axisStroke,
            font: chartTokens.axisFont,
            grid: { stroke: chartTokens.gridStroke, width: 1 },
            ticks: { stroke: chartTokens.axisTickStroke, width: 1, size: 5 },
            values: (u, splits) => splits.map((v) => Math.round(v).toLocaleString() + " bp"),
          },
          {
            stroke: chartTokens.axisStroke,
            font: chartTokens.axisFont,
            grid: { stroke: chartTokens.gridStroke, width: 1 },
            ticks: { stroke: chartTokens.axisTickStroke, width: 1, size: 5 },
            values: (u, splits) => splits.map((v) => v.toFixed(1) + "%"),
            size: 60,
          },
        ],
        hooks: {
          setCursor: [updateTooltip],
        },
      };
      try {
        chart = new uPlot(opts, data, chartHost);
        chartHost.addEventListener("mouseleave", () => tooltipEl.classList.remove("visible"));
      } catch (err) {
        chartHostError("uPlot threw: " + (err && err.message ? err.message : String(err)));
      }
    }

    // ----------------------------------------------------------------
    // Survival section: a second chart + table inside the same panel.
    // The chart shows current-side win rate as a function of distance
    // from the 5m line, one series per remaining-minutes bucket. The
    // table inverts the question: how much distance does each remaining
    // bucket need to historically reach a given win-rate target?
    // ----------------------------------------------------------------

    const formatBp = (v) => {
      if (v == null || !Number.isFinite(v)) return "—";
      return Math.round(v).toLocaleString() + " bp";
    };

    function survivalChartHostError(msg) {
      survivalChartHost.innerHTML = '<pre class="chart-error">' + msg + '</pre>';
    }

    function renderSurvivalEmpty(message) {
      if (survivalChart) { survivalChart.destroy(); survivalChart = null; }
      survivalChartHost.innerHTML = '<div class="chart-loading">' + message + '</div>';
      if (survivalTbodyEl) survivalTbodyEl.innerHTML = "";
      if (survivalMetaEl) survivalMetaEl.textContent = "";
    }

    function renderSurvivalChart(survival) {
      if (survivalChart) { survivalChart.destroy(); survivalChart = null; }
      survivalChartHost.innerHTML = "";
      if (typeof uPlot === "undefined") {
        survivalChartHostError("uPlot global is undefined — CDN failed to load?");
        return;
      }
      const w = survivalChartHost.clientWidth || survivalChartHost.getBoundingClientRect().width || 800;
      const h = survivalChartHost.clientHeight || 380;
      if (w === 0 || h === 0) {
        survivalChartHostError("chart host has zero size: " + w + "x" + h);
        return;
      }
      // Shared x-axis is every integer bp across the display range; each
      // remaining-minutes series is a parallel y array (null for sparse
      // buckets, which uPlot draws as gaps).
      const xs = survival.distancesBp.slice();
      const yArrays = survivalRemainingOrder.map(
        (rem) => survival.byRemaining[rem].winRate.slice(),
      );
      const sampleArrays = survivalRemainingOrder.map(
        (rem) => survival.byRemaining[rem].sampleCount.slice(),
      );
      const data = [xs].concat(yArrays);
      const series = [{}].concat(
        survivalRemainingOrder.map((rem) => ({
          label: rem + "m left",
          stroke: survivalRemainingColors[rem],
          width: 2,
          spanGaps: false,
          points: { show: false },
        })),
      );
      const updateTooltip = (u) => {
        const idx = u.cursor.idx;
        if (idx == null || idx < 0 || idx >= xs.length) {
          survivalTooltipEl.classList.remove("visible");
          return;
        }
        const x = xs[idx];
        let rows = '';
        for (let i = 0; i < survivalRemainingOrder.length; i++) {
          const rem = survivalRemainingOrder[i];
          const wr = yArrays[i][idx];
          const n = sampleArrays[i][idx];
          const value = wr == null
            ? '<span class="value" style="color: var(--alea-text-subtle)">n=' + n.toLocaleString() + '</span>'
            : '<span class="value">' + wr.toFixed(1) + '% <span style="color: var(--alea-text-subtle); font-weight: 400; margin-left: 6px">n=' + n.toLocaleString() + '</span></span>';
          rows +=
            '<div class="alea-tooltip-row"><span class="alea-legend-swatch" style="background:' + survivalRemainingColors[rem] + '"></span><span class="name">' + rem + 'm left</span>' + value + '</div>';
        }
        survivalTooltipEl.innerHTML =
          '<div class="alea-tooltip-head">' + formatBp(x) + ' from line</div>' + rows;
        const cursorLeft = u.cursor.left;
        const frameW = survivalChartFrame.getBoundingClientRect().width;
        const tooltipW = survivalTooltipEl.offsetWidth || 240;
        const margin = 14;
        const placeRight = cursorLeft + margin + tooltipW <= frameW;
        const left = placeRight ? cursorLeft + margin : cursorLeft - margin - tooltipW;
        survivalTooltipEl.style.left = Math.max(margin, Math.min(left, frameW - tooltipW - margin)) + "px";
        survivalTooltipEl.style.top = "14px";
        survivalTooltipEl.classList.add("visible");
      };
      const opts = {
        width: w,
        height: h,
        legend: { show: false },
        padding: [16, 18, 8, 8],
        scales: {
          x: { time: false },
          y: { range: [0, 100] },
        },
        cursor: {
          points: { show: false },
          drag: { setScale: false, x: false, y: false },
        },
        series: series,
        axes: [
          {
            stroke: chartTokens.axisStroke,
            font: chartTokens.axisFont,
            grid: { stroke: chartTokens.gridStroke, width: 1 },
            ticks: { stroke: chartTokens.axisTickStroke, width: 1, size: 5 },
            values: (u, splits) => splits.map(formatBp),
          },
          {
            stroke: chartTokens.axisStroke,
            font: chartTokens.axisFont,
            grid: { stroke: chartTokens.gridStroke, width: 1 },
            ticks: { stroke: chartTokens.axisTickStroke, width: 1, size: 5 },
            values: (u, splits) => splits.map((v) => Math.round(v) + "%"),
            size: 60,
          },
        ],
        hooks: {
          setCursor: [updateTooltip],
          // Faint horizontal reference at 50% (coin-flip baseline). Drawn
          // behind the curves via drawAxes, same pattern as the body/wick
          // chart's p50 line.
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
        survivalChart = new uPlot(opts, data, survivalChartHost);
        survivalChartHost.addEventListener("mouseleave", () => survivalTooltipEl.classList.remove("visible"));
      } catch (err) {
        survivalChartHostError("uPlot threw: " + (err && err.message ? err.message : String(err)));
      }
    }

    function renderSurvivalTable(survival) {
      if (!survivalTbodyEl) return;
      let html = "";
      for (const rem of survivalRemainingOrder) {
        const winRate = survival.byRemaining[rem].winRate;
        const sampleCount = survival.byRemaining[rem].sampleCount;
        let row = '<tr><th scope="row">' + rem + 'm left</th>';
        for (const target of survivalTargetWinRates) {
          let cellBp = null;
          for (let i = 0; i < winRate.length; i++) {
            const wr = winRate[i];
            if (wr == null) continue;
            if (sampleCount[i] < survivalMinSamples) continue;
            if (wr >= target) { cellBp = survival.distancesBp[i]; break; }
          }
          row += cellBp == null
            ? '<td class="empty">—</td>'
            : '<td>' + formatBp(cellBp) + '</td>';
        }
        row += '</tr>';
        html += row;
      }
      survivalTbodyEl.innerHTML = html;
    }

    function renderSurvival(slice) {
      const survival = slice.survival;
      if (!survival) {
        renderSurvivalEmpty("No 1m candle data yet for " + slice.assetUpper + ".");
        return;
      }
      if (survivalMetaEl) {
        survivalMetaEl.textContent = survival.windowCount.toLocaleString() + " 5m windows";
      }
      renderSurvivalChart(survival);
      renderSurvivalTable(survival);
    }

    // ----------------------------------------------------------------
    // Filter sections: one per binary filter, each with a small-multiples
    // grid of mini-charts (one per remaining-minutes bucket) plus a
    // 12-row threshold table showing baseline vs filter-true vs
    // filter-false with deltas.
    // ----------------------------------------------------------------

    const filterColors = ${JSON.stringify(FILTER_COLORS)};
    const filterSectionsHost = document.getElementById("filter-sections-host");
    // Track every mini-chart uPlot instance so the ResizeObserver and
    // window resize handler can poke them all when the viewport changes.
    const filterCharts = [];

    function clearFilterSections() {
      for (const entry of filterCharts) {
        try { entry.chart.destroy(); } catch (e) { /* ignore */ }
      }
      filterCharts.length = 0;
      if (filterSectionsHost) filterSectionsHost.innerHTML = "";
    }

    function formatPercent(v) {
      if (v == null || !Number.isFinite(v)) return "—";
      const pct = v * 100;
      return pct < 10 ? pct.toFixed(1) + "%" : Math.round(pct) + "%";
    }

    function formatBpDelta(filterBp, baselineBp) {
      if (filterBp === null || filterBp === "thin") return "";
      if (baselineBp === null || baselineBp === "thin") return "";
      const delta = filterBp - baselineBp;
      if (delta === 0) {
        return ' <span class="delta-flat">·</span>';
      }
      if (delta < 0) {
        return ' <span class="delta-good">↓' + Math.abs(delta) + '</span>';
      }
      return ' <span class="delta-bad">↑' + delta + '</span>';
    }

    function thresholdCellHtml(cell, options) {
      if (cell === "thin") {
        return '<td class="thin">thin</td>';
      }
      if (cell === null) {
        return '<td class="empty">—</td>';
      }
      const deltaHtml = options && options.baselineCell !== undefined
        ? formatBpDelta(cell, options.baselineCell)
        : "";
      return '<td>' + cell + ' bp' + deltaHtml + '</td>';
    }

    function renderFilterTable(filter) {
      const rows = [];
      const remainingOrder = survivalRemainingOrder;
      for (let g = 0; g < remainingOrder.length; g++) {
        const rem = remainingOrder[g];
        const baselineCells = filter.thresholds.baseline[rem];
        const trueCells = filter.thresholds.whenTrue[rem];
        const falseCells = filter.thresholds.whenFalse[rem];
        const remainingLabel = rem + 'm left';
        // Baseline row
        let baselineRow = '<tr class="row-baseline"><th scope="row">' + remainingLabel + ' · baseline</th>';
        for (let i = 0; i < baselineCells.length; i++) {
          baselineRow += thresholdCellHtml(baselineCells[i]);
        }
        baselineRow += '</tr>';
        // Filter-true row
        let trueRow = '<tr class="row-when-true"><th scope="row">↳ ' + filter.trueLabel + '</th>';
        for (let i = 0; i < trueCells.length; i++) {
          trueRow += thresholdCellHtml(trueCells[i], { baselineCell: baselineCells[i] });
        }
        trueRow += '</tr>';
        // Filter-false row (with group-end class on the last filter group
        // to draw a separating border between remaining-minutes groups)
        const isLastGroup = g === remainingOrder.length - 1;
        const groupEndClass = isLastGroup ? "" : " row-group-end";
        let falseRow = '<tr class="row-when-false' + groupEndClass + '"><th scope="row">↳ ' + filter.falseLabel + '</th>';
        for (let i = 0; i < falseCells.length; i++) {
          falseRow += thresholdCellHtml(falseCells[i], { baselineCell: baselineCells[i] });
        }
        falseRow += '</tr>';
        rows.push(baselineRow, trueRow, falseRow);
      }
      return rows.join("");
    }

    function renderFilterMiniChart(host, filter, remaining) {
      if (typeof uPlot === "undefined") {
        host.innerHTML = '<pre class="chart-error">uPlot global is undefined</pre>';
        return null;
      }
      const w = host.clientWidth || host.getBoundingClientRect().width || 480;
      const h = host.clientHeight || 220;
      if (w === 0 || h === 0) {
        host.innerHTML = '<pre class="chart-error">chart host has zero size</pre>';
        return null;
      }
      const xs = filter.distancesBp.slice();
      const baselineY = filter.baseline[remaining].winRate.slice();
      const trueY = filter.whenTrue[remaining].winRate.slice();
      const falseY = filter.whenFalse[remaining].winRate.slice();
      const data = [xs, baselineY, trueY, falseY];
      const opts = {
        width: w,
        height: h,
        legend: { show: false },
        padding: [10, 14, 6, 6],
        scales: { x: { time: false }, y: { range: [0, 100] } },
        cursor: { points: { show: false }, drag: { setScale: false, x: false, y: false } },
        series: [
          {},
          { label: "baseline", stroke: filterColors.baseline, width: 1.25, spanGaps: false, points: { show: false } },
          { label: filter.trueLabel, stroke: filterColors.whenTrue, width: 2, spanGaps: false, points: { show: false } },
          { label: filter.falseLabel, stroke: filterColors.whenFalse, width: 2, spanGaps: false, points: { show: false } },
        ],
        axes: [
          {
            stroke: chartTokens.axisStroke,
            font: chartTokens.axisFont,
            grid: { stroke: chartTokens.gridStroke, width: 1 },
            ticks: { stroke: chartTokens.axisTickStroke, width: 1, size: 4 },
            values: (u, splits) => splits.map((v) => Math.round(v) + ' bp'),
            size: 32,
          },
          {
            stroke: chartTokens.axisStroke,
            font: chartTokens.axisFont,
            grid: { stroke: chartTokens.gridStroke, width: 1 },
            ticks: { stroke: chartTokens.axisTickStroke, width: 1, size: 4 },
            values: (u, splits) => splits.map((v) => Math.round(v) + '%'),
            size: 44,
          },
        ],
        hooks: {
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
        return new uPlot(opts, data, host);
      } catch (err) {
        host.innerHTML = '<pre class="chart-error">uPlot threw: ' + (err && err.message ? err.message : String(err)) + '</pre>';
        return null;
      }
    }

    function renderFilterSection(filter) {
      // Build the section markup, attach to host, then construct mini
      // charts after attach (so the chart hosts have measurable size).
      const summary = filter.summary;
      const summaryParts = [];
      if (Number.isFinite(summary.occurrenceTrue)) {
        summaryParts.push(
          '<span class="filter-summary-pill"><span class="filter-summary-key">' + filter.trueLabel + '</span><span class="filter-summary-value">' + formatPercent(summary.occurrenceTrue) + ' of windows</span></span>'
        );
      }
      if (Number.isFinite(summary.occurrenceFalse)) {
        summaryParts.push(
          '<span class="filter-summary-pill"><span class="filter-summary-key">' + filter.falseLabel + '</span><span class="filter-summary-value">' + formatPercent(summary.occurrenceFalse) + '</span></span>'
        );
      }
      function bestImprovementHtml(label, value) {
        if (value === null || !Number.isFinite(value)) return "";
        const cls = value < 0 ? "filter-summary-good" : value > 0 ? "filter-summary-bad" : "";
        const sign = value < 0 ? "↓" + Math.abs(value) : value > 0 ? "↑" + value : "·";
        return '<span class="filter-summary-pill"><span class="filter-summary-key">best Δ ' + label + '</span><span class="filter-summary-value ' + cls + '">' + sign + ' bp</span></span>';
      }
      summaryParts.push(bestImprovementHtml(filter.trueLabel, summary.bestImprovementBpTrue));
      summaryParts.push(bestImprovementHtml(filter.falseLabel, summary.bestImprovementBpFalse));
      if (summary.snapshotsSkipped > 0) {
        summaryParts.push(
          '<span class="filter-summary-pill"><span class="filter-summary-key">skipped</span><span class="filter-summary-value">' + summary.snapshotsSkipped.toLocaleString() + '</span></span>'
        );
      }
      const summaryHtml = summaryParts.join("");
      const legendHtml =
        '<span class="alea-legend-item"><span class="alea-legend-swatch" style="background:' + filterColors.baseline + '"></span>baseline</span>' +
        '<span class="alea-legend-item"><span class="alea-legend-swatch" style="background:' + filterColors.whenTrue + '"></span>' + filter.trueLabel + '</span>' +
        '<span class="alea-legend-item"><span class="alea-legend-swatch" style="background:' + filterColors.whenFalse + '"></span>' + filter.falseLabel + '</span>';
      const cellsHtml = survivalRemainingOrder.map((rem) =>
        '<div class="filter-chart-cell">' +
          '<div class="filter-chart-cell-label">' + rem + 'm left</div>' +
          '<div class="chart-frame">' +
            '<div class="chart-host" data-filter-id="' + filter.id + '" data-remaining="' + rem + '"></div>' +
          '</div>' +
        '</div>'
      ).join("");
      const tableHeader = survivalTargetWinRates.map((rate) => '<th scope="col">' + rate + '%</th>').join("");
      const sectionHtml =
        '<section class="filter-section" data-filter-id="' + filter.id + '">' +
          '<div class="alea-section-rule"><h2>' + filter.displayName + '</h2></div>' +
          '<p class="survival-helper">' + filter.description + '</p>' +
          '<p class="filter-summary-line">' + summaryHtml + '</p>' +
          '<div class="alea-legend">' + legendHtml + '</div>' +
          '<div class="filter-chart-grid">' + cellsHtml + '</div>' +
          '<div class="alea-table-wrap">' +
            '<table class="alea-table filter-thresholds">' +
              '<thead><tr><th scope="col"></th>' + tableHeader + '</tr></thead>' +
              '<tbody>' + renderFilterTable(filter) + '</tbody>' +
            '</table>' +
          '</div>' +
        '</section>';
      if (!filterSectionsHost) return;
      filterSectionsHost.insertAdjacentHTML('beforeend', sectionHtml);
      // After insertion, find the four mini-chart hosts for this filter
      // and instantiate uPlot for each.
      const hosts = filterSectionsHost.querySelectorAll('.chart-host[data-filter-id="' + filter.id + '"]');
      hosts.forEach((host) => {
        const rem = Number(host.getAttribute('data-remaining'));
        const chart = renderFilterMiniChart(host, filter, rem);
        if (chart) filterCharts.push({ chart, host });
      });
    }

    function renderFilters(slice) {
      clearFilterSections();
      if (!filterSectionsHost) return;
      if (!slice.filters || slice.filters.length === 0) {
        filterSectionsHost.innerHTML = '<div class="survival-empty">No filter overlays available — needs 1m candle data.</div>';
        return;
      }
      for (const filter of slice.filters) {
        renderFilterSection(filter);
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
      renderSurvival(slice);
      renderFilters(slice);
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
      const survivalRo = new ResizeObserver(() => {
        if (!survivalChart) return;
        const w = survivalChartHost.clientWidth;
        const h = survivalChartHost.clientHeight;
        if (w > 0 && h > 0) survivalChart.setSize({ width: w, height: h });
      });
      survivalRo.observe(survivalChartHost);
      // Single ResizeObserver covering every filter mini-chart host;
      // the entry list lets us only resize the affected chart instead of
      // looping all of them on every observation.
      const filterRo = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const host = entry.target;
          const match = filterCharts.find((fc) => fc.host === host);
          if (!match) continue;
          const w = host.clientWidth;
          const h = host.clientHeight;
          if (w > 0 && h > 0) match.chart.setSize({ width: w, height: h });
        }
      });
      // Attach a MutationObserver so that as new mini-chart hosts appear
      // (when the user switches tabs), we begin observing them too.
      if (filterSectionsHost) {
        const mo = new MutationObserver(() => {
          const hosts = filterSectionsHost.querySelectorAll('.chart-host[data-filter-id]');
          hosts.forEach((h) => filterRo.observe(h));
        });
        mo.observe(filterSectionsHost, { childList: true, subtree: true });
      }
    }
    window.addEventListener("resize", () => {
      if (chart) chart.setSize({ width: chartHost.clientWidth, height: chartHost.clientHeight });
      if (survivalChart) survivalChart.setSize({ width: survivalChartHost.clientWidth, height: survivalChartHost.clientHeight });
      for (const entry of filterCharts) {
        const w = entry.host.clientWidth;
        const h = entry.host.clientHeight;
        if (w > 0 && h > 0) entry.chart.setSize({ width: w, height: h });
      }
    });

    if (slices.length > 0) activate(slices[0].asset);
  </script>
</body>
</html>
`;
}

function toDashboardSlice({
  asset,
  survival,
  filters,
}: {
  readonly asset: AssetSizeDistribution;
  readonly survival: AssetSurvivalDistribution | null;
  readonly filters: AssetSurvivalFilters | null;
}): DashboardAssetSlice {
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
    histogram: asset.histogram,
    survival: survival === null ? null : toSurvivalSlice({ survival }),
    filters:
      filters === null
        ? []
        : filters.results.map((result) => toFilterSlice({ result })),
  };
}

/**
 * Pivots one filter result into chart-ready densified arrays plus the
 * pre-computed threshold matrix the table reads. The same densification
 * pattern as `toSurvivalSlice` runs three times — once per surface
 * (baseline / whenTrue / whenFalse) — so each mini-chart can iterate a
 * shared x-axis with `null` gaps for sparse buckets.
 */
function toFilterSlice({
  result,
}: {
  readonly result: SurvivalFilterResultPayload;
}): FilterSlice {
  const distancesBp: number[] = [];
  for (let bp = 0; bp < SURVIVAL_MAX_DISTANCE_BP; bp += 1) {
    distancesBp.push(bp);
  }
  return {
    id: result.id,
    displayName: result.displayName,
    description: result.description,
    trueLabel: result.trueLabel,
    falseLabel: result.falseLabel,
    distancesBp,
    baseline: densifySurface({ surface: result.baseline, distancesBp }),
    whenTrue: densifySurface({ surface: result.whenTrue, distancesBp }),
    whenFalse: densifySurface({ surface: result.whenFalse, distancesBp }),
    thresholds: {
      baseline: thresholdMatrix({ surface: result.baseline }),
      whenTrue: thresholdMatrix({ surface: result.whenTrue }),
      whenFalse: thresholdMatrix({ surface: result.whenFalse }),
    },
    summary: {
      snapshotsTrue: result.summary.snapshotsTrue,
      snapshotsFalse: result.summary.snapshotsFalse,
      snapshotsSkipped: result.summary.snapshotsSkipped,
      occurrenceTrue: result.summary.occurrenceTrue,
      occurrenceFalse: result.summary.occurrenceFalse,
      bestImprovementBpTrue: result.summary.bestImprovementBpTrue,
      bestImprovementBpFalse: result.summary.bestImprovementBpFalse,
    },
  };
}

function densifySurface({
  surface,
  distancesBp,
}: {
  readonly surface: SurvivalSurfaceWithCount;
  readonly distancesBp: readonly number[];
}): FilterSurfaceArrays {
  const out = {} as Record<
    SurvivalRemainingMinutes,
    { winRate: (number | null)[]; sampleCount: number[] }
  >;
  for (const remaining of SURVIVAL_REMAINING_ORDER) {
    const buckets = surface.byRemaining[remaining];
    const byDistance = new Map<number, { total: number; survived: number }>();
    for (const bucket of buckets) {
      byDistance.set(bucket.distanceBp, {
        total: bucket.total,
        survived: bucket.survived,
      });
    }
    const winRate: (number | null)[] = [];
    const sampleCount: number[] = [];
    for (const bp of distancesBp) {
      const bucket = byDistance.get(bp);
      if (bucket === undefined || bucket.total === 0) {
        winRate.push(null);
        sampleCount.push(0);
        continue;
      }
      sampleCount.push(bucket.total);
      if (bucket.total < SURVIVAL_MIN_SAMPLES) {
        winRate.push(null);
        continue;
      }
      winRate.push((bucket.survived / bucket.total) * 100);
    }
    out[remaining] = { winRate, sampleCount };
  }
  return out;
}

/**
 * Pre-computes the "first distance bucket reaching each target win rate"
 * matrix per surface. Distinguishes "never reaches in display range"
 * (`null`) from "all buckets in range are below the sample-count floor"
 * (`"thin"`) so the renderer can use different sentinels in the table.
 */
function thresholdMatrix({
  surface,
}: {
  readonly surface: SurvivalSurfaceWithCount;
}): ThresholdMatrixSerialized {
  const out = {} as Record<SurvivalRemainingMinutes, ThresholdCell[]>;
  for (const remaining of SURVIVAL_REMAINING_ORDER) {
    const buckets = surface.byRemaining[remaining];
    const cells: ThresholdCell[] = [];
    for (const target of SURVIVAL_TARGET_WIN_RATES) {
      let answered: ThresholdCell = null;
      let sawAnyBucket = false;
      let sawTrustedBucket = false;
      for (const bucket of buckets) {
        if (bucket.distanceBp >= SURVIVAL_MAX_DISTANCE_BP) {
          break;
        }
        sawAnyBucket = true;
        if (bucket.total < SURVIVAL_MIN_SAMPLES) {
          continue;
        }
        sawTrustedBucket = true;
        const winRate = (bucket.survived / bucket.total) * 100;
        if (winRate >= target) {
          answered = bucket.distanceBp;
          break;
        }
      }
      if (answered === null && sawAnyBucket && !sawTrustedBucket) {
        answered = "thin";
      }
      cells.push(answered);
    }
    out[remaining] = cells;
  }
  return out;
}

/**
 * Pivots the per-asset survival distribution into chart-ready arrays
 * indexed by `distancesBp` (0..MAX-1, every integer bp). The compute step
 * stores buckets as a sparse list keyed by distance; here we densify so
 * the chart can iterate a fixed x-axis. Buckets below the sample-count
 * floor are kept as `null` win-rate values (rendered as gaps) but their
 * raw `sampleCount` is preserved for tooltips.
 */
function toSurvivalSlice({
  survival,
}: {
  readonly survival: AssetSurvivalDistribution;
}): SurvivalSlice {
  const distancesBp: number[] = [];
  for (let bp = 0; bp < SURVIVAL_MAX_DISTANCE_BP; bp += 1) {
    distancesBp.push(bp);
  }
  const byRemaining = {} as Record<
    SurvivalRemainingMinutes,
    { winRate: (number | null)[]; sampleCount: number[] }
  >;
  for (const remaining of SURVIVAL_REMAINING_ORDER) {
    const buckets = survival.all.byRemaining[remaining];
    const byDistance = new Map<number, { total: number; survived: number }>();
    for (const bucket of buckets) {
      byDistance.set(bucket.distanceBp, {
        total: bucket.total,
        survived: bucket.survived,
      });
    }
    const winRate: (number | null)[] = [];
    const sampleCount: number[] = [];
    for (const bp of distancesBp) {
      const bucket = byDistance.get(bp);
      if (bucket === undefined || bucket.total === 0) {
        winRate.push(null);
        sampleCount.push(0);
        continue;
      }
      sampleCount.push(bucket.total);
      if (bucket.total < SURVIVAL_MIN_SAMPLES) {
        winRate.push(null);
        continue;
      }
      winRate.push((bucket.survived / bucket.total) * 100);
    }
    byRemaining[remaining] = { winRate, sampleCount };
  }
  return {
    windowCount: survival.windowCount,
    distancesBp,
    byRemaining,
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
