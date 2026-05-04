import type {
  AssetSizeDistribution,
  AssetSurvivalDistribution,
  AssetSurvivalFilters,
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
 * Minimum snapshot count required for a `(remaining, distance)` survival
 * bucket to be considered trustworthy: rendered as a chart point with a
 * filled marker. Buckets below this floor are hidden as gaps. Tuned at
 * 300 — conservative enough given a few years of 1m candles (~100k+
 * snapshots per remaining-minutes bucket per asset) without hiding the
 * mid-tail data we actually want to read.
 */
const SURVIVAL_MIN_SAMPLES = 300;

/**
 * Hard cap on the x-axis range for the survival chart, in basis points.
 * The chart auto-fits to the largest distance any line actually reaches
 * (after the sample-count floor cuts off the noisy tail) plus a small
 * pad, so most asset/filter combinations end well below this — the cap
 * is just a sanity ceiling.
 */
const SURVIVAL_MAX_DISTANCE_BP = 75;

/**
 * Padding (bp) added to the right edge after auto-fitting the chart to
 * the data. Keeps the rightmost line away from the axis without leaving
 * the wasteland of empty space we had at the fixed 75bp cap.
 */
const SURVIVAL_X_AXIS_PAD_BP = 2;

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

/**
 * Color scheme for the delta-from-baseline charts. Line strokes are a
 * non-green/red pair (cool blue for true, warm gold for false) so that
 * the green/red fill semantic — green above the neutral line, red below
 * — never collides with the line color. The line just identifies which
 * half; the fill carries "is this slice above or below baseline?".
 */
const DELTA_COLORS = {
  trueLine: "#5b95ff",
  falseLine: "#d7aa45",
  fillAbove: { r: 70, g: 195, b: 123 },
  fillBelow: { r: 216, g: 90, b: 79 },
  zeroRule: "rgba(215, 170, 69, 0.45)",
} as const;

type DashboardAssetSlice = {
  readonly asset: string;
  readonly assetUpper: string;
  readonly candleCount: number;
  readonly yearRange: string | null;
  readonly survival: SurvivalSlice | null;
  readonly filters: readonly FilterSlice[];
};

/**
 * Chart-ready data for one filter section. Three densified surfaces
 * (baseline / whenTrue / whenFalse) sharing the same `distancesBp`
 * x-axis, plus per-remaining best-improvement metrics that drive the
 * tab badges and the default-selected tab.
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
  readonly summary: {
    readonly snapshotsTrue: number;
    readonly snapshotsFalse: number;
    readonly snapshotsSkipped: number;
    readonly occurrenceTrue: number;
    readonly occurrenceFalse: number;
    readonly scoresByRemaining: Readonly<
      Record<
        SurvivalRemainingMinutes,
        { readonly true: ScoreSlice; readonly false: ScoreSlice }
      >
    >;
  };
  /**
   * Pre-picked best remaining-minutes bucket: the one whose
   * `max(|true.score|, |false.score|)` is largest. That's where the
   * filter has its strongest signal in either direction (do-trade or
   * avoid-trade). `4` is used as a fallback when no bucket has any
   * comparable data, so the chart always has something to default to.
   */
  readonly defaultRemaining: SurvivalRemainingMinutes;
};

/**
 * Mirror of `SurvivalScorePayload` reshaped for the renderer. Same
 * fields, copied through `toFilterSlice` so the JSON serialized into
 * the page is the renderer's canonical view of the score (no further
 * normalization on the client).
 */
type ScoreSlice = {
  readonly score: number;
  readonly coverageBp: number;
  readonly meanDeltaPp: number | null;
  readonly maxDeltaPp: number | null;
  readonly minDeltaPp: number | null;
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
 * `training:distributions` analysis. One tab per asset; each tab shows
 * the unconditional point-of-no-return survival surface as the
 * "Baseline" section, then one collapsible section per registered
 * filter overlay below it. Filter sections render their main
 * survival-vs-baseline chart and a delta-from-baseline chart with
 * density-weighted fills.
 *
 * The body/range size distribution and per-year breakdowns are
 * computed and persisted in the JSON sidecar but not rendered here —
 * the dashboard focuses on the trading-relevant survival surface.
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
  const survivalLegendItems = SURVIVAL_REMAINING_ORDER.map(
    (rem) =>
      `<span class="alea-legend-item"><span class="alea-legend-swatch" style="background:${SURVIVAL_REMAINING_COLORS[rem]}"></span>${rem}m left</span>`,
  ).join("");

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Alea · Training · Point-of-No-Return</title>
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

    /* Push the candle-count meta to the right edge of the card header. */
    .alea-card-meta-end { margin-left: auto; }

    /* Survival section: a chart inside the asset panel. Spacing matches
       the surrounding blocks so the section reads as a sibling rather
       than a new card. */
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

    /* Filter overlay sections — one per binary filter. Same visual
       language as the survival section but with a remaining-minutes tab
       row above a single full-size chart. */
    .filter-sections-host { display: flex; flex-direction: column; gap: 14px; }

    /* Remaining-minutes tab row above each filter chart. Compact
       segmented-control feel: subtle background, antique-gold underline
       on the active tab to match the asset tabs at the top of the page. */
    .filter-tabs {
      display: inline-flex;
      gap: 0;
      align-self: flex-start;
      border: 1px solid var(--alea-border-muted);
      border-radius: 8px;
      overflow: hidden;
      background: linear-gradient(
        180deg,
        rgba(16, 23, 15, 0.92),
        rgba(8, 10, 8, 0.92)
      );
    }
    .filter-tab {
      padding: 10px 22px;
      border: 0;
      background: transparent;
      color: var(--alea-text-subtle);
      font-family: var(--alea-font-sans);
      font-size: 11.5px;
      font-weight: 600;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      cursor: pointer;
      border-right: 1px solid var(--alea-border-muted);
      transition: color 120ms ease, background-color 120ms ease;
      outline: none;
      font-variant-numeric: tabular-nums;
    }
    .filter-tab:last-child { border-right: 0; }
    .filter-tab:hover,
    .filter-tab:focus-visible {
      color: var(--alea-text);
      background: rgba(215, 170, 69, 0.04);
    }
    .filter-tab:focus-visible {
      outline: 1px solid var(--alea-border-strong);
      outline-offset: -3px;
    }
    .filter-tab.active {
      color: var(--alea-gold);
      background: rgba(215, 170, 69, 0.06);
      box-shadow: inset 0 -2px 0 0 var(--alea-gold);
    }
    .filter-tab .filter-tab-delta {
      margin-left: 16px;
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.04em;
      text-transform: none;
      color: var(--alea-text-subtle);
    }
    .filter-tab .filter-tab-delta-good {
      color: var(--alea-green);
      font-weight: 600;
    }
    .filter-tab .filter-tab-delta-bad {
      color: var(--alea-red);
      font-weight: 600;
      margin-left: 6px;
    }
    .filter-tab.active .filter-tab-delta-good { color: var(--alea-green); }
    .filter-tab.active .filter-tab-delta-bad { color: var(--alea-red); }
    /* Asset-wide best/worst hotspot dots, prepended to the tab label. */
    .filter-tab .filter-tab-dot {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      margin-right: 8px;
      vertical-align: middle;
      box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.4);
    }
    .filter-tab .filter-tab-dot-best { background: var(--alea-green); }
    .filter-tab .filter-tab-dot-worst { background: var(--alea-red); }

    /* Collapsible filter section. Each filter is a <details> element so
       the page can scale to a dozen+ filters without becoming a wall.
       Collapsed state shows the filter title + a row of per-config
       score pills so the operator can scan signal strength across all
       filters at a glance before deciding what to expand. */
    details.filter-section {
      border: 1px solid var(--alea-border-muted);
      border-radius: 12px;
      background: linear-gradient(
        180deg,
        rgba(16, 23, 15, 0.7),
        rgba(8, 10, 8, 0.5)
      );
      overflow: hidden;
      transition: border-color 120ms ease;
    }
    details.filter-section[open] {
      border-color: var(--alea-border);
    }
    /* Two-row grid summary at every viewport: row 1 holds the
       filter title and the expand/collapse chevron, row 2 holds
       the score pills full-width. We deliberately don't try to
       fit everything on one row at desktop — tablet widths produce
       inconsistent layouts (chevron drops to row 2 only when the
       title is too long), and the grid form reads cleanly at all
       sizes: row 1 is "what is this filter and how do I open it",
       row 2 is "what's its current performance". */
    details.filter-section > summary {
      list-style: none;
      cursor: pointer;
      padding: 16px 20px;
      display: grid;
      grid-template-columns: 1fr auto;
      grid-template-rows: auto auto;
      column-gap: 18px;
      row-gap: 12px;
      align-items: center;
      user-select: none;
      transition: background-color 120ms ease;
    }
    details.filter-section > summary::-webkit-details-marker { display: none; }
    details.filter-section > summary:hover {
      background: rgba(215, 170, 69, 0.04);
    }
    details.filter-section > summary > .filter-summary-title {
      grid-column: 1;
      grid-row: 1;
      font-family: var(--alea-font-display);
      font-weight: 600;
      font-size: 17px;
      letter-spacing: 0.04em;
      color: var(--alea-text);
      margin: 0;
      min-width: 0;
    }
    details.filter-section > summary > .filter-summary-chevron {
      grid-column: 2;
      grid-row: 1;
      color: var(--alea-text-subtle);
      font-size: 11px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      white-space: nowrap;
      transition: transform 160ms ease, color 120ms ease;
    }
    details.filter-section[open] > summary > .filter-summary-chevron {
      color: var(--alea-gold);
    }
    /* When the section is open the in-section tab strip is the
       canonical source for per-rem scores; the collapsed-header
       summary pills would just duplicate it, so hide them. */
    details.filter-section[open] > summary > .filter-summary-scores {
      display: none;
    }
    /* Score pills span the full width on their own row. Pills are
       fixed 140px so columns line up across filter sections. The
       gap is generous (14px) so adjacent pills don't visually
       collide; inside each pill the rem-to-value gap is tighter
       (8px) so the rem and its scores read as one unit. */
    details.filter-section > summary > .filter-summary-scores {
      grid-column: 1 / -1;
      grid-row: 2;
      display: flex;
      gap: 14px;
      flex-wrap: wrap;
      align-items: center;
      justify-content: flex-start;
    }
    /* Score pills shown in the collapsed header — non-interactive
       summary of the per-config scores. Fixed-width so pills line up
       across rows of different filters. Inside each pill, the rem
       label sits in a fixed slot followed by the +/- score pair with
       a wider gap; the +/- pair itself sits tight against each other. */
    .filter-summary-score {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 4px 10px;
      border-radius: 6px;
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid var(--alea-border-faint);
      font-family: var(--alea-font-sans);
      font-size: 11px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      font-variant-numeric: tabular-nums;
      color: var(--alea-text-subtle);
      min-width: 140px;
      box-sizing: border-box;
    }
    .filter-summary-score .score-rem {
      color: var(--alea-text-muted);
      flex-shrink: 0;
    }
    .filter-summary-score .score-value {
      letter-spacing: 0.04em;
      text-transform: none;
      font-size: 12px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-left: auto;
    }
    .filter-summary-score .score-value-good {
      color: var(--alea-green);
      font-weight: 600;
    }
    .filter-summary-score .score-value-bad {
      color: var(--alea-red);
      font-weight: 600;
    }
    .filter-summary-score .score-value-sep {
      display: none;
    }
    .filter-summary-score .filter-tab-dot {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.4);
    }
    /* Body of the expanded section — sits inside the details element. */
    .filter-section-body {
      padding: 0 20px 22px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    /* Delta-from-baseline chart, stacked under each filter's main chart. */
    .filter-delta-frame {
      position: relative;
      border-radius: 10px;
      background:
        radial-gradient(circle at 92% 10%, rgba(215, 170, 69, 0.05), transparent 36%),
        linear-gradient(180deg, rgba(15, 27, 18, 0.6), rgba(7, 9, 10, 0.4));
      border: 1px solid var(--alea-border-muted);
      padding: 12px 8px 6px;
    }
    .filter-delta-host {
      position: relative;
      width: 100%;
      height: 260px;
      min-height: 260px;
      max-height: 260px;
    }

    /* Mobile / narrow-viewport tweaks. The base layout assumes there's
       enough horizontal room for the filter title, a row of pills, and
       a chevron in the same line, plus a full-width tab strip with
       inline score badges. On phones we use a 2x2 grid for pills, keep
       title + chevron locked on the same row regardless of title length
       (CSS grid avoids the flex-wrap problem long titles caused), and
       fade the right edge of the tab strip so the user can see there's
       more to scroll to. */
    @media (max-width: 720px) {
      /* Asset tabs: drop the 96px min-width so all 5 assets fit one
         row with proportional sizing, instead of wrapping 3+2. */
      .alea-tabs { flex-wrap: nowrap; }
      .alea-tab {
        min-width: 0;
        padding: 11px 6px;
        font-size: 11.5px;
        letter-spacing: 0.12em;
      }

      /* The base summary already uses the 2-row grid; mobile only
         needs to tighten padding + typography. */
      details.filter-section > summary {
        column-gap: 10px;
        row-gap: 10px;
        padding: 14px 16px;
      }
      details.filter-section > summary > .filter-summary-title {
        font-size: 15.5px;
        line-height: 1.25;
      }
      details.filter-section > summary > .filter-summary-chevron {
        align-self: start;
      }
      /* Tighter pill grid on mobile: smaller between-pill gap so
         two pills fit per row, with the inner rem-to-value gap
         already tightened by the base style. */
      details.filter-section > summary > .filter-summary-scores {
        gap: 6px;
      }
      .filter-summary-score {
        flex: 1 1 calc(50% - 3px);
        min-width: 0;
        padding: 5px 10px;
      }

      .filter-section-body { padding: 0 14px 18px; gap: 12px; }

      /* Inline tab strip with a fading-right gradient so users can
         see there's more to scroll to when 4 tabs don't fit in
         viewport width. The mask is applied to the strip itself,
         not the chart frame, so charts stay crisp. */
      .filter-tabs {
        display: flex;
        width: 100%;
        align-self: stretch;
        overflow-x: auto;
        scrollbar-width: none;
        -webkit-mask-image: linear-gradient(to right, black calc(100% - 24px), transparent);
                mask-image: linear-gradient(to right, black calc(100% - 24px), transparent);
      }
      .filter-tabs::-webkit-scrollbar { display: none; }
      .filter-tab {
        flex: 1 1 0;
        padding: 8px 10px;
        font-size: 11px;
        letter-spacing: 0.08em;
        white-space: nowrap;
      }
      .filter-tab .filter-tab-delta {
        margin-left: 8px;
        white-space: nowrap;
      }

      /* Tighter chart heights on mobile — the baseline + delta charts
         each lose ~60px of unnecessary chrome at phone widths. */
      .chart-frame { padding: 10px 8px 4px; }
      .chart-host { height: 280px; min-height: 280px; max-height: 280px; }
      .filter-delta-frame { padding: 10px 8px 4px; }
      .filter-delta-host { height: 200px; min-height: 200px; max-height: 200px; }

      /* Tighter typography on the page header + survival helper. */
      .alea-subtitle { font-size: 11.5px; }
      .survival-helper { font-size: 12px; line-height: 1.45; }
    }
  </style>
</head>
<body>
  <div class="alea-shell">
    <header class="alea-header">
      <div class="alea-brand-row">${aleaBrandMark()}</div>
      <h1 class="alea-title">Training · Point-of-No-Return</h1>
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
          <h2>Baseline</h2>
        </div>
        <p class="survival-helper">Unconditional point-of-no-return surface: at every distance from the 5m start line and every minutes-remaining bucket, the historical win rate of the side currently leading. Filter overlays below split the same data by simple binary context filters and read deltas against this curve. Buckets with fewer than ${SURVIVAL_MIN_SAMPLES.toLocaleString()} snapshots are hidden.</p>

        <div class="survival-section" id="survival-section">
          <p class="alea-card-meta" id="survival-meta"></p>
          <div class="alea-legend">
            ${survivalLegendItems}
          </div>
          <div class="chart-frame">
            <div id="survival-chart" class="chart-host"><div class="chart-loading">Loading chart…</div></div>
            <div id="survival-tooltip" class="alea-tooltip"></div>
          </div>
        </div>

        <div class="alea-section-rule">
          <h2>Filter Overlays</h2>
        </div>
        <p class="survival-helper">Each filter splits the same survival snapshots in two, so we can ask "does this slice of context tighten the point of no return?". The chart compares baseline vs filter-true vs filter-false at one remaining-time bucket.</p>

        <div class="filter-sections-host" id="filter-sections-host"></div>
      </section>
    </main>
  </div>
  <script>
    const slices = ${JSON.stringify(slices)};
    const chartTokens = ${JSON.stringify(aleaChartTokens)};
    const survivalRemainingOrder = ${JSON.stringify(SURVIVAL_REMAINING_ORDER)};
    const survivalRemainingColors = ${JSON.stringify(SURVIVAL_REMAINING_COLORS)};
    const survivalMinSamples = ${SURVIVAL_MIN_SAMPLES};
    const survivalXAxisPadBp = ${SURVIVAL_X_AXIS_PAD_BP};

    // Auto-fit the y-axis to actual data range, clamped to [0, 100] for
    // the % charts. The hard-coded [0, 100] was wasting most of the
    // chart's vertical real estate because survival rates rarely touch
    // either extreme — cropping to (min - pad, max + pad) makes the
    // mid-section actually readable. Pads are floored so charts with a
    // tight range still get some breathing room.
    function autoFitPercentYRange({ yArrays, includeReferenceFifty }) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const ys of yArrays) {
        for (const v of ys) {
          if (v == null || !Number.isFinite(v)) continue;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 100];
      // Keep the 50% reference visible when it's near (or just outside)
      // the data range, so the chart can show the coin-flip line for
      // intuition; skip when the data is way above 50% to stop wasting
      // height showing the line in isolation.
      if (includeReferenceFifty && lo > 50 && lo - 50 < 10) lo = 50;
      const span = Math.max(5, hi - lo);
      const pad = Math.max(2, span * 0.08);
      return [Math.max(0, lo - pad), Math.min(100, hi + pad)];
    }

    // Largest distance bucket index where any of the given y arrays still
    // has a (finite) value. Returns the matching bp + a small pad so the
    // rightmost line stays a few bp away from the axis. Falls back to
    // the original axis cap if no point qualifies — keeps the chart
    // sane on empty data.
    function autoFitMaxBp({ xs, yArrays }) {
      let maxIdx = -1;
      for (const ys of yArrays) {
        for (let i = ys.length - 1; i > maxIdx; i--) {
          const v = ys[i];
          if (v != null && Number.isFinite(v)) {
            maxIdx = i;
            break;
          }
        }
      }
      if (maxIdx < 0) {
        return xs[xs.length - 1] != null ? xs[xs.length - 1] : 1;
      }
      const lastBp = xs[maxIdx] != null ? xs[maxIdx] : maxIdx;
      const padded = lastBp + survivalXAxisPadBp;
      const cap = xs[xs.length - 1] != null ? xs[xs.length - 1] + 1 : padded;
      return Math.min(padded, cap);
    }

    const tabsEl = document.getElementById("tabs");
    const titleEl = document.getElementById("asset-title");
    const metaEl = document.getElementById("asset-meta");
    const countEl = document.getElementById("asset-count");

    const survivalSectionEl = document.getElementById("survival-section");
    const survivalMetaEl = document.getElementById("survival-meta");
    const survivalChartHost = document.getElementById("survival-chart");
    const survivalTooltipEl = document.getElementById("survival-tooltip");
    const survivalChartFrame = survivalChartHost.parentElement;
    let survivalChart = null;

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
      // Auto-fit the x-axis to where data actually ends. The fixed-cap
      // version left a ton of empty space on the right when even the
      // longest line died out at ~30 bp.
      const xMax = autoFitMaxBp({ xs: xs, yArrays: yArrays });
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
        scales: (() => {
          const yRange = autoFitPercentYRange({
            yArrays: yArrays,
            includeReferenceFifty: true,
          });
          return {
            x: { time: false, range: [0, xMax] },
            y: { range: yRange },
          };
        })(),
        cursor: {
          points: { show: false },
          drag: { setScale: false, x: false, y: false },
        },
        series: series,
        axes: [
          {
            stroke: chartTokens.axisStroke,
            font: chartTokens.axisFont,
            labelFont: chartTokens.axisFont,
            label: "distance from price line (bp)",
            labelSize: 28,
            grid: { stroke: chartTokens.gridStroke, width: 1 },
            ticks: { stroke: chartTokens.axisTickStroke, width: 1, size: 5 },
            values: (u, splits) => splits.map((v) => Math.round(v).toLocaleString()),
          },
          {
            stroke: chartTokens.axisStroke,
            font: chartTokens.axisFont,
            labelFont: chartTokens.axisFont,
            label: "hold rate %",
            labelSize: 28,
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
    }

    // ----------------------------------------------------------------
    // Filter sections: one per binary filter. Each section renders a
    // single full-size chart at one remaining-minutes bucket, with a
    // tab row above it for switching buckets. The default tab is the
    // bucket where the filter most strongly tightens the point of no
    // return. Tab badges show the per-bucket best improvement so the
    // operator sees at a glance where the filter helps before clicking.
    // ----------------------------------------------------------------

    const filterColors = ${JSON.stringify(FILTER_COLORS)};
    const filterSectionsHost = document.getElementById("filter-sections-host");
    // Track every filter-chart uPlot instance so the ResizeObserver and
    // window resize handler can poke them all when the viewport changes.
    // Each entry also carries the filter slice + currently-selected
    // remaining-minutes bucket so the tab click handler can replace the
    // chart in place.
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

    // Returns the largest-magnitude positive score and the largest-
    // magnitude negative score across BOTH halves of a tab. Binary
    // filter halves are anti-correlated: at every comparable bucket
    // one half's delta is positive and the other negative, so the
    // summed scores almost always have opposite signs. Showing only
    // one (the larger-magnitude one) hid half the story — we want
    // both the do-trade and avoid-trade signal visible at once so
    // neither side is implicitly painted as good or bad.
    //
    // Returns null when neither half has any comparable buckets;
    // otherwise an object with positive and negative (either may be
    // null on its own when both halves happened to land on the same
    // sign — degenerate, but possible with sample-weighted scoring).
    function pickTabBothScores(remainingEntry) {
      const trueOk = remainingEntry.true.coverageBp > 0;
      const falseOk = remainingEntry.false.coverageBp > 0;
      if (!trueOk && !falseOk) return null;
      const scores = [];
      if (trueOk) scores.push(remainingEntry.true.score);
      if (falseOk) scores.push(remainingEntry.false.score);
      let positive = null;
      let negative = null;
      for (const s of scores) {
        if (s > 0 && (positive === null || s > positive)) positive = s;
        if (s < 0 && (negative === null || s < negative)) negative = s;
      }
      // Magnitude used by the tab sort + default-tab picker.
      const magnitude = Math.max.apply(null, scores.map(Math.abs));
      return { positive: positive, negative: negative, magnitude: magnitude };
    }

    function formatScoreNumber(value) {
      if (value === null || value === undefined || !Number.isFinite(value)) return "—";
      return Math.abs(Math.round(value)).toString();
    }

    function formatTabBadge(remainingEntry) {
      const pair = pickTabBothScores(remainingEntry);
      if (pair === null) return "";
      const parts = [];
      if (pair.positive !== null) {
        parts.push(
          '<span class="filter-tab-delta-good">+' +
            formatScoreNumber(pair.positive) +
            '</span>',
        );
      }
      if (pair.negative !== null) {
        parts.push(
          '<span class="filter-tab-delta-bad">−' +
            formatScoreNumber(pair.negative) +
            '</span>',
        );
      }
      if (parts.length === 0) return "";
      return ' <span class="filter-tab-delta">' + parts.join(' ') + '</span>';
    }

    function buildFilterChart({ host, filter, remaining }) {
      if (typeof uPlot === "undefined") {
        host.innerHTML = '<pre class="chart-error">uPlot global is undefined — CDN failed to load?</pre>';
        return null;
      }
      const w = host.clientWidth || host.getBoundingClientRect().width || 800;
      const h = host.clientHeight || 380;
      if (w === 0 || h === 0) {
        host.innerHTML = '<pre class="chart-error">chart host has zero size: ' + w + 'x' + h + '</pre>';
        return null;
      }
      const xs = filter.distancesBp.slice();
      const baselineY = filter.baseline[remaining].winRate.slice();
      const trueY = filter.whenTrue[remaining].winRate.slice();
      const falseY = filter.whenFalse[remaining].winRate.slice();
      const xMax = autoFitMaxBp({ xs: xs, yArrays: [baselineY, trueY, falseY] });
      const data = [xs, baselineY, trueY, falseY];
      const opts = {
        width: w,
        height: h,
        legend: { show: false },
        padding: [16, 18, 8, 8],
        scales: {
          x: { time: false, range: [0, xMax] },
          y: {
            range: autoFitPercentYRange({
              yArrays: [baselineY, trueY, falseY],
              includeReferenceFifty: true,
            }),
          },
        },
        cursor: { points: { show: false }, drag: { setScale: false, x: false, y: false } },
        series: [
          {},
          { label: "baseline", stroke: filterColors.baseline, width: 1.5, spanGaps: false, points: { show: false } },
          { label: filter.trueLabel, stroke: filterColors.whenTrue, width: 2.25, spanGaps: false, points: { show: false } },
          { label: filter.falseLabel, stroke: filterColors.whenFalse, width: 2.25, spanGaps: false, points: { show: false } },
        ],
        axes: [
          {
            stroke: chartTokens.axisStroke,
            font: chartTokens.axisFont,
            labelFont: chartTokens.axisFont,
            label: "distance from price line (bp)",
            labelSize: 28,
            grid: { stroke: chartTokens.gridStroke, width: 1 },
            ticks: { stroke: chartTokens.axisTickStroke, width: 1, size: 5 },
            values: (u, splits) => splits.map((v) => Math.round(v).toLocaleString()),
          },
          {
            stroke: chartTokens.axisStroke,
            font: chartTokens.axisFont,
            labelFont: chartTokens.axisFont,
            label: "hold rate %",
            labelSize: 28,
            grid: { stroke: chartTokens.gridStroke, width: 1 },
            ticks: { stroke: chartTokens.axisTickStroke, width: 1, size: 5 },
            values: (u, splits) => splits.map((v) => Math.round(v) + '%'),
            size: 60,
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

    // ----------------------------------------------------------------
    // Delta chart: same x-axis as the main chart but the y-axis is
    // (filter_winRate − baseline_winRate) in pp. Two lines (true/false)
    // — no baseline line drawn (baseline = the y=0 axis). Per-slice
    // density fills under each line, green where the slice is above
    // baseline and red where below; opacity scales with the bucket's
    // sample count so sparse slices look faint and trustworthy ones
    // look bold.
    // ----------------------------------------------------------------

    const deltaColors = ${JSON.stringify(DELTA_COLORS)};

    // Build the per-line "(filter delta in pp, sample count)" arrays for
    // a given remaining-minutes bucket. A delta value is null when
    // either side (filter half or baseline) lacks a usable bucket at
    // that bp.
    function buildDeltaLine({ filter, half, remaining }) {
      const baselineEntry = filter.baseline[remaining];
      const halfEntry = filter[half === "true" ? "whenTrue" : "whenFalse"][remaining];
      const xs = filter.distancesBp;
      const deltas = [];
      const counts = [];
      for (let i = 0; i < xs.length; i++) {
        const baseV = baselineEntry.winRate[i];
        const halfV = halfEntry.winRate[i];
        if (baseV == null || halfV == null) {
          deltas.push(null);
        } else {
          deltas.push(halfV - baseV);
        }
        counts.push(halfEntry.sampleCount[i] || 0);
      }
      return { deltas: deltas, counts: counts };
    }

    function buildDeltaChart({ host, filter, remaining }) {
      if (typeof uPlot === "undefined") {
        host.innerHTML = '<pre class="chart-error">uPlot global is undefined</pre>';
        return null;
      }
      const w = host.clientWidth || host.getBoundingClientRect().width || 800;
      const h = host.clientHeight || 260;
      if (w === 0 || h === 0) {
        host.innerHTML = '<pre class="chart-error">chart host has zero size: ' + w + 'x' + h + '</pre>';
        return null;
      }
      const xs = filter.distancesBp.slice();
      const trueLine = buildDeltaLine({ filter: filter, half: "true", remaining: remaining });
      const falseLine = buildDeltaLine({ filter: filter, half: "false", remaining: remaining });
      const xMax = autoFitMaxBp({ xs: xs, yArrays: [trueLine.deltas, falseLine.deltas] });

      // Y-axis bounds: symmetric around 0 with a small pad. We don't
      // want it to drift to wildly asymmetric ranges that visually
      // distort which side is bigger.
      let extreme = 0;
      for (const a of [trueLine.deltas, falseLine.deltas]) {
        for (const v of a) {
          if (v != null && Number.isFinite(v) && Math.abs(v) > extreme) {
            extreme = Math.abs(v);
          }
        }
      }
      const yPad = Math.max(2, extreme * 0.15);
      const yMax = extreme === 0 ? 5 : extreme + yPad;

      // Densest slice across both halves; per-slice opacity is
      // count / maxCount, with a small floor so non-empty slices remain
      // visible.
      let maxCount = 0;
      for (const a of [trueLine.counts, falseLine.counts]) {
        for (const v of a) {
          if (v > maxCount) maxCount = v;
        }
      }
      const fillOpacityFor = (count) => {
        if (maxCount === 0 || count === 0) return 0;
        const ratio = count / maxCount;
        // Floor + cap tuned upward from the original (0.06–0.55) since
        // the dark green panel background was washing out faint slices.
        // Floor at 0.18 so even a barely-above-floor slice has visible
        // tint; cap at 0.85 so dense slices read as solid color without
        // completely hiding the line on top.
        return Math.max(0.18, Math.min(0.85, ratio * 0.85));
      };

      // Draw a per-bin trapezoid from the line down to y=0, colored by
      // the average sign of the bin's two endpoints, with opacity from
      // the bin's average sample count. Done in a uPlot draw hook so
      // we can do per-slice opacity (uPlot's built-in fill is uniform).
      const drawDensityFill = (u, deltas, counts) => {
        const ctx = u.ctx;
        const yZeroPx = u.valToPos(0, "y", true);
        for (let i = 0; i < xs.length - 1; i++) {
          const v0 = deltas[i];
          const v1 = deltas[i + 1];
          if (v0 == null || v1 == null) continue;
          const c0 = counts[i] || 0;
          const c1 = counts[i + 1] || 0;
          const avgCount = (c0 + c1) / 2;
          const opacity = fillOpacityFor(avgCount);
          if (opacity <= 0) continue;
          const x0Px = u.valToPos(xs[i], "x", true);
          const x1Px = u.valToPos(xs[i + 1], "x", true);
          const y0Px = u.valToPos(v0, "y", true);
          const y1Px = u.valToPos(v1, "y", true);
          // Color decision: average sign of v0 and v1. If both above 0,
          // green. Both below, red. Crossing zero, split into two
          // sub-trapezoids at the zero crossing.
          const drawTrap = (xa, ya, xb, yb, color) => {
            ctx.fillStyle = 'rgba(' + color.r + ',' + color.g + ',' + color.b + ',' + opacity + ')';
            ctx.beginPath();
            ctx.moveTo(xa, yZeroPx);
            ctx.lineTo(xa, ya);
            ctx.lineTo(xb, yb);
            ctx.lineTo(xb, yZeroPx);
            ctx.closePath();
            ctx.fill();
          };
          const sameSign = (v0 >= 0 && v1 >= 0) || (v0 <= 0 && v1 <= 0);
          if (sameSign) {
            const color = (v0 + v1) / 2 >= 0 ? deltaColors.fillAbove : deltaColors.fillBelow;
            drawTrap(x0Px, y0Px, x1Px, y1Px, color);
          } else {
            // Find the zero crossing's x position via linear interp.
            const t = v0 / (v0 - v1);
            const xCrossVal = xs[i] + t * (xs[i + 1] - xs[i]);
            const xCrossPx = u.valToPos(xCrossVal, "x", true);
            const firstColor = v0 >= 0 ? deltaColors.fillAbove : deltaColors.fillBelow;
            const secondColor = v1 >= 0 ? deltaColors.fillAbove : deltaColors.fillBelow;
            drawTrap(x0Px, y0Px, xCrossPx, yZeroPx, firstColor);
            drawTrap(xCrossPx, yZeroPx, x1Px, y1Px, secondColor);
          }
        }
      };

      const data = [xs, trueLine.deltas.slice(), falseLine.deltas.slice()];
      const opts = {
        width: w,
        height: h,
        legend: { show: false },
        padding: [12, 18, 8, 8],
        scales: { x: { time: false, range: [0, xMax] }, y: { range: [-yMax, yMax] } },
        cursor: { points: { show: false }, drag: { setScale: false, x: false, y: false } },
        series: [
          {},
          { label: filter.trueLabel, stroke: deltaColors.trueLine, width: 2, spanGaps: false, points: { show: false } },
          { label: filter.falseLabel, stroke: deltaColors.falseLine, width: 2, spanGaps: false, points: { show: false } },
        ],
        axes: [
          {
            stroke: chartTokens.axisStroke,
            font: chartTokens.axisFont,
            labelFont: chartTokens.axisFont,
            label: "distance from price line (bp)",
            labelSize: 28,
            grid: { stroke: chartTokens.gridStroke, width: 1 },
            ticks: { stroke: chartTokens.axisTickStroke, width: 1, size: 5 },
            values: (u, splits) => splits.map((v) => Math.round(v).toLocaleString()),
          },
          {
            stroke: chartTokens.axisStroke,
            font: chartTokens.axisFont,
            labelFont: chartTokens.axisFont,
            label: "vs baseline (Δ%)",
            labelSize: 28,
            grid: { stroke: chartTokens.gridStroke, width: 1 },
            ticks: { stroke: chartTokens.axisTickStroke, width: 1, size: 5 },
            values: (u, splits) => splits.map((v) => (v > 0 ? "+" : "") + Math.round(v)),
            size: 60,
          },
        ],
        hooks: {
          // Density fills first (under the lines), then the zero rule,
          // then uPlot draws the line strokes on top.
          drawClear: [
            (u) => {
              drawDensityFill(u, trueLine.deltas, trueLine.counts);
              drawDensityFill(u, falseLine.deltas, falseLine.counts);
            },
          ],
          drawAxes: [
            (u) => {
              const yPos = u.valToPos(0, "y", true);
              const ctx = u.ctx;
              ctx.save();
              ctx.strokeStyle = deltaColors.zeroRule;
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

    function renderFilterSection(filter, hotspots, expanded) {
      const summary = filter.summary;
      const legendHtml =
        '<span class="alea-legend-item"><span class="alea-legend-swatch" style="background:' + filterColors.baseline + '"></span>baseline</span>' +
        '<span class="alea-legend-item"><span class="alea-legend-swatch" style="background:' + filterColors.whenTrue + '"></span>' + filter.trueLabel + '</span>' +
        '<span class="alea-legend-item"><span class="alea-legend-swatch" style="background:' + filterColors.whenFalse + '"></span>' + filter.falseLabel + '</span>';

      // Tabs render in fixed 4m → 1m order so the operator can compare
      // the same column across filters at a glance. The strongest
      // signal still gets the default-selected highlight (via
      // filter.defaultRemaining), but the order itself stays put.
      const tabsSorted = survivalRemainingOrder.slice().map((rem) => {
        const pair = pickTabBothScores(summary.scoresByRemaining[rem]);
        return { rem: rem, pair: pair };
      });
      const tabsHtml = tabsSorted.map((entry) => {
        const rem = entry.rem;
        const isActive = rem === filter.defaultRemaining;
        const badge = formatTabBadge(summary.scoresByRemaining[rem]);
        // Asset-wide "best signal" / "worst signal" hotspots get a
        // small dot before the label, so the operator can spot the top
        // do-trade and avoid-trade configs at a glance across every
        // filter section. Both can apply to the same tab when the
        // binary halves split into both extremes there.
        let dot = "";
        if (hotspots.best && hotspots.best.filterId === filter.id && hotspots.best.remaining === rem) {
          dot += '<span class="filter-tab-dot filter-tab-dot-best" title="strongest do-trade signal for this asset"></span>';
        }
        if (hotspots.worst && hotspots.worst.filterId === filter.id && hotspots.worst.remaining === rem) {
          dot += '<span class="filter-tab-dot filter-tab-dot-worst" title="strongest avoid-trade signal for this asset"></span>';
        }
        return (
          '<button type="button" class="filter-tab' + (isActive ? ' active' : '') +
          '" data-filter-id="' + filter.id + '" data-remaining="' + rem + '">' +
          dot + rem + 'm left' + badge + '</button>'
        );
      }).join("");
      // Per-config score pills shown in the collapsed header. Same
      // 4m → 1m order as the tabs and chart legend so the operator
      // can scan the same column across filters at a glance.
      const summaryScoresHtml = tabsSorted.map((entry) => {
        const rem = entry.rem;
        const pair = entry.pair;
        const valueParts = [];
        if (pair !== null) {
          if (pair.positive !== null) {
            valueParts.push(
              '<span class="score-value-good">+' +
                formatScoreNumber(pair.positive) +
                '</span>',
            );
          }
          if (pair.negative !== null) {
            valueParts.push(
              '<span class="score-value-bad">−' +
                formatScoreNumber(pair.negative) +
                '</span>',
            );
          }
        }
        const valueHtml = valueParts.length > 0
          ? valueParts.join('<span class="score-value-sep"> </span>')
          : '<span class="score-value">—</span>';
        let dot = "";
        if (hotspots.best && hotspots.best.filterId === filter.id && hotspots.best.remaining === rem) {
          dot += '<span class="filter-tab-dot filter-tab-dot-best" title="strongest do-trade signal for this asset"></span>';
        }
        if (hotspots.worst && hotspots.worst.filterId === filter.id && hotspots.worst.remaining === rem) {
          dot += '<span class="filter-tab-dot filter-tab-dot-worst" title="strongest avoid-trade signal for this asset"></span>';
        }
        return (
          '<span class="filter-summary-score">' +
            dot +
            '<span class="score-rem">' + rem + 'm</span>' +
            '<span class="score-value">' + valueHtml + '</span>' +
          '</span>'
        );
      }).join("");

      // <details> defaults to collapsed; the top-ranked filter for
      // the asset is rendered with the open attribute so its chart is
      // visible without a click. Charts are NOT built here — they're
      // lazy-built on first expand by the toggle listener so we don't
      // render uPlot into a 0-size host.
      const openAttr = expanded ? ' open' : '';
      const chevronText = expanded ? 'collapse ▴' : 'expand ▾';
      const sectionHtml =
        '<details class="filter-section" data-filter-id="' + filter.id + '"' + openAttr + '>' +
          '<summary>' +
            '<h2 class="filter-summary-title">' + filter.displayName + '</h2>' +
            '<div class="filter-summary-scores">' + summaryScoresHtml + '</div>' +
            '<span class="filter-summary-chevron">' + chevronText + '</span>' +
          '</summary>' +
          '<div class="filter-section-body">' +
            '<p class="survival-helper">' + filter.description + '</p>' +
            '<div class="filter-tabs" role="tablist">' + tabsHtml + '</div>' +
            '<div class="alea-legend">' + legendHtml + '</div>' +
            '<div class="chart-frame">' +
              '<div class="chart-host filter-chart-host" data-filter-id="' + filter.id + '"></div>' +
            '</div>' +
            '<div class="filter-delta-frame">' +
              '<div class="filter-delta-host" data-filter-id="' + filter.id + '"></div>' +
            '</div>' +
          '</div>' +
        '</details>';
      if (!filterSectionsHost) return;
      filterSectionsHost.insertAdjacentHTML('beforeend', sectionHtml);
      const detailsEl = filterSectionsHost.querySelector('details.filter-section[data-filter-id="' + filter.id + '"]');
      if (!detailsEl) return;
      // Lazy chart construction: only when first opened. Subsequent
      // tab clicks update the existing charts; subsequent open/close
      // doesn't rebuild anything. We also trigger this immediately
      // for sections rendered with the open attribute (the auto-
      // expanded top filter), since the open attribute on details
      // does not fire a toggle event on initial mount.
      const buildIfNeeded = () => {
        if (!detailsEl.open || detailsEl.dataset.built === '1') return;
        detailsEl.dataset.built = '1';
        const chevron = detailsEl.querySelector('.filter-summary-chevron');
        if (chevron) chevron.textContent = 'collapse ▴';
        const host = detailsEl.querySelector('.filter-chart-host');
        const deltaHost = detailsEl.querySelector('.filter-delta-host');
        if (!host || !deltaHost) return;
        const chart = buildFilterChart({ host: host, filter: filter, remaining: filter.defaultRemaining });
        const deltaChart = buildDeltaChart({ host: deltaHost, filter: filter, remaining: filter.defaultRemaining });
        if (chart) {
          filterCharts.push({
            chart: chart,
            deltaChart: deltaChart,
            host: host,
            deltaHost: deltaHost,
            filter: filter,
            remaining: filter.defaultRemaining,
          });
        }
      };
      detailsEl.addEventListener('toggle', buildIfNeeded);
      if (expanded) {
        buildIfNeeded();
      }
      // Update chevron text when the user collapses again.
      detailsEl.addEventListener('toggle', () => {
        const chevron = detailsEl.querySelector('.filter-summary-chevron');
        if (chevron) chevron.textContent = detailsEl.open ? 'collapse ▴' : 'expand ▾';
      });
    }

    function setFilterRemaining({ filterId, remaining }) {
      const entryIdx = filterCharts.findIndex((e) => e.filter.id === filterId);
      if (entryIdx < 0) return;
      const entry = filterCharts[entryIdx];
      try { entry.chart.destroy(); } catch (e) { /* ignore */ }
      try { if (entry.deltaChart) entry.deltaChart.destroy(); } catch (e) { /* ignore */ }
      const newChart = buildFilterChart({ host: entry.host, filter: entry.filter, remaining: remaining });
      const newDeltaChart = buildDeltaChart({ host: entry.deltaHost, filter: entry.filter, remaining: remaining });
      if (newChart) {
        filterCharts[entryIdx] = {
          chart: newChart,
          deltaChart: newDeltaChart,
          host: entry.host,
          deltaHost: entry.deltaHost,
          filter: entry.filter,
          remaining: remaining,
        };
      }
      // Sync tab active state.
      const tabs = filterSectionsHost.querySelectorAll('.filter-tab[data-filter-id="' + filterId + '"]');
      tabs.forEach((tab) => {
        const tabRem = Number(tab.getAttribute('data-remaining'));
        tab.classList.toggle('active', tabRem === remaining);
      });
    }

    // Walks every (filter, remaining, half) score across the asset and
    // returns the most-positive ("best signal" — strongest do-trade) and
    // most-negative ("worst signal" — strongest avoid-trade). Each gets a
    // small dot on its tab so the operator can find them at a glance.
    function findHotspots(filters) {
      let best = null;
      let worst = null;
      for (const f of filters) {
        for (const rem of survivalRemainingOrder) {
          const entry = f.summary.scoresByRemaining[rem];
          for (const side of ["true", "false"]) {
            const s = entry[side];
            if (s.coverageBp === 0) continue;
            const ref = { filterId: f.id, remaining: rem, half: side, score: s.score };
            if (best === null || s.score > best.score) best = ref;
            if (worst === null || s.score < worst.score) worst = ref;
          }
        }
      }
      // Binary filter halves are anti-correlated, so the global most-
      // positive and most-negative scores frequently land on the SAME
      // tab. Don't suppress one — render both dots in that case. The
      // tab is genuinely the most extreme in both directions.
      return { best: best, worst: worst };
    }

    // Strongest tradeable signal magnitude across this filter's tabs.
    // Both signs are useful (positive = do-trade, negative = avoid-
    // trade) so we rank by max |score|, not max positive only.
    function filterBestScoreMagnitude(filter) {
      let best = -Infinity;
      const scores = filter.summary.scoresByRemaining;
      for (const rem of survivalRemainingOrder) {
        const s = scores[rem];
        if (!s) continue;
        const mag = Math.max(Math.abs(s.true.score), Math.abs(s.false.score));
        if (mag > best) best = mag;
      }
      return Number.isFinite(best) ? best : -Infinity;
    }

    function renderFilters(slice) {
      clearFilterSections();
      if (!filterSectionsHost) return;
      if (!slice.filters || slice.filters.length === 0) {
        filterSectionsHost.innerHTML = '<div class="survival-empty">No filter overlays available — needs 1m candle data.</div>';
        return;
      }
      const hotspots = findHotspots(slice.filters);
      // Sort by strongest |score| so the asset's most informative
      // edge is up top regardless of sign, and auto-expand that top
      // filter so the user sees its chart on first paint.
      const ranked = slice.filters.slice().sort((a, b) => filterBestScoreMagnitude(b) - filterBestScoreMagnitude(a));
      ranked.forEach((filter, idx) => {
        renderFilterSection(filter, hotspots, idx === 0);
      });
    }

    if (filterSectionsHost) {
      filterSectionsHost.addEventListener('click', (e) => {
        const target = e.target instanceof HTMLElement ? e.target : null;
        if (!target) return;
        const tab = target.closest('.filter-tab');
        if (!(tab instanceof HTMLElement)) return;
        const filterId = tab.getAttribute('data-filter-id');
        const remaining = Number(tab.getAttribute('data-remaining'));
        if (!filterId || !Number.isFinite(remaining)) return;
        setFilterRemaining({ filterId: filterId, remaining: remaining });
        tab.blur();
      });
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
      const survivalRo = new ResizeObserver(() => {
        if (!survivalChart) return;
        const w = survivalChartHost.clientWidth;
        const h = survivalChartHost.clientHeight;
        if (w > 0 && h > 0) survivalChart.setSize({ width: w, height: h });
      });
      survivalRo.observe(survivalChartHost);
      // Single ResizeObserver covers both the main chart hosts and the
      // delta-chart hosts; the entry list lets us only resize what
      // actually moved.
      const filterRo = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const host = entry.target;
          const match = filterCharts.find((fc) => fc.host === host || fc.deltaHost === host);
          if (!match) continue;
          const w = host.clientWidth;
          const h = host.clientHeight;
          if (w <= 0 || h <= 0) continue;
          if (host === match.host) {
            match.chart.setSize({ width: w, height: h });
          } else if (match.deltaChart) {
            match.deltaChart.setSize({ width: w, height: h });
          }
        }
      });
      // Attach a MutationObserver so that as new chart hosts appear
      // (when the user switches asset tabs and we re-render), we begin
      // observing them too.
      if (filterSectionsHost) {
        const mo = new MutationObserver(() => {
          const mainHosts = filterSectionsHost.querySelectorAll('.filter-chart-host');
          mainHosts.forEach((h) => filterRo.observe(h));
          const deltaHosts = filterSectionsHost.querySelectorAll('.filter-delta-host');
          deltaHosts.forEach((h) => filterRo.observe(h));
        });
        mo.observe(filterSectionsHost, { childList: true, subtree: true });
      }
    }
    window.addEventListener("resize", () => {
      if (survivalChart) survivalChart.setSize({ width: survivalChartHost.clientWidth, height: survivalChartHost.clientHeight });
      for (const entry of filterCharts) {
        const w = entry.host.clientWidth;
        const h = entry.host.clientHeight;
        if (w > 0 && h > 0) entry.chart.setSize({ width: w, height: h });
        if (entry.deltaChart) {
          const dw = entry.deltaHost.clientWidth;
          const dh = entry.deltaHost.clientHeight;
          if (dw > 0 && dh > 0) entry.deltaChart.setSize({ width: dw, height: dh });
        }
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
    survival: survival === null ? null : toSurvivalSlice({ survival }),
    filters:
      filters === null
        ? []
        : filters.results.map((result) => toFilterSlice({ result })),
  };
}

/**
 * Pivots one filter result into chart-ready densified arrays. Same
 * densification pattern as `toSurvivalSlice`, run three times — once per
 * surface (baseline / whenTrue / whenFalse) — so the chart can iterate a
 * shared x-axis with `null` gaps for sparse buckets.
 *
 * Also picks the default remaining-minutes tab: the bucket where the
 * filter most strongly tightens the point of no return.
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
    summary: {
      snapshotsTrue: result.summary.snapshotsTrue,
      snapshotsFalse: result.summary.snapshotsFalse,
      snapshotsSkipped: result.summary.snapshotsSkipped,
      occurrenceTrue: result.summary.occurrenceTrue,
      occurrenceFalse: result.summary.occurrenceFalse,
      scoresByRemaining: result.summary.scoresByRemaining,
    },
    defaultRemaining: pickDefaultRemaining({
      scoresByRemaining: result.summary.scoresByRemaining,
    }),
  };
}

/**
 * Picks the remaining-minutes bucket whose `max(|true.score|, |false.score|)`
 * is largest — i.e. where the filter has its strongest signal in either
 * direction. Falls back to `4` (4m left) when no bucket has any
 * comparable data, so the default is deterministic.
 */
function pickDefaultRemaining({
  scoresByRemaining,
}: {
  readonly scoresByRemaining: Readonly<
    Record<
      SurvivalRemainingMinutes,
      {
        readonly true: { readonly score: number; readonly coverageBp: number };
        readonly false: { readonly score: number; readonly coverageBp: number };
      }
    >
  >;
}): SurvivalRemainingMinutes {
  let bestRemaining: SurvivalRemainingMinutes = 4;
  let bestMagnitude = -1;
  for (const remaining of SURVIVAL_REMAINING_ORDER) {
    const entry = scoresByRemaining[remaining];
    if (entry.true.coverageBp === 0 && entry.false.coverageBp === 0) {
      continue;
    }
    const magnitude = Math.max(
      entry.true.coverageBp > 0 ? Math.abs(entry.true.score) : 0,
      entry.false.coverageBp > 0 ? Math.abs(entry.false.score) : 0,
    );
    if (magnitude > bestMagnitude) {
      bestMagnitude = magnitude;
      bestRemaining = remaining;
    }
  }
  return bestRemaining;
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
