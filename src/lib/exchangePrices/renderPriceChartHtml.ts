import { exchangePerpVolumeWeights } from "@alea/lib/exchangePrices/exchangePerpVolumeWeights";
import { exchangeSpotVolumeWeights } from "@alea/lib/exchangePrices/exchangeSpotVolumeWeights";
import { interpolateMidsAtTimestamps } from "@alea/lib/exchangePrices/interpolateMidsAtTimestamps";
import type { ExchangeId, QuoteTick } from "@alea/types/exchanges";

type RenderPriceChartHtmlParams = {
  readonly ticks: readonly QuoteTick[];
  readonly tickCounts: Partial<Record<ExchangeId, number>>;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly exhaustive: boolean;
};

/**
 * Renders a self-contained light-themed HTML chart of mid-price BBO ticks
 * per exchange using uPlot. Two synced panels stacked vertically:
 *
 *   - Top panel: spot venues + spot VWAP + polymarket-chainlink (which is
 *     a Chainlink-derived spot oracle).
 *   - Bottom panel: perp/swap venues + perp VWAP.
 *
 * Each panel's y-axis auto-fits its own data, so there is no wasted space
 * between the two clusters (they typically sit ~$30 apart due to funding-
 * rate basis). Both panels share an x-cursor so hovering anywhere
 * highlights the same instant in both, and a single floating tooltip
 * lists every series across both panels.
 *
 * Every series is linearly interpolated onto a single 100ms grid so the
 * cursor finds every series' value at every x — no gaps from the slower
 * Chainlink feed.
 */
export function renderPriceChartHtml({
  ticks,
  startedAtMs,
  endedAtMs,
  exhaustive,
}: RenderPriceChartHtmlParams): string {
  const grid = buildGrid({ startedAtMs, endedAtMs, binMs: gridBinMs });
  const ticksByExchange = groupTicksByExchange({ ticks });
  const panels = buildPanelData({ ticksByExchange, grid, exhaustive });
  const tickCountsByExchange = countTicksByExchange({ ticksByExchange });
  const tickCountBars = buildTickCountBars({ tickCountsByExchange });

  const title = "Exchange Price Latency";

  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.classless.min.css" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/uplot@1.6.30/dist/uPlot.min.css" />
  <script src="https://cdn.jsdelivr.net/npm/uplot@1.6.30/dist/uPlot.iife.min.js" charset="utf-8"></script>
  <style>
    /* Pico provides typography + color tokens; this block only overrides
       where the temp-dashboard needs a full-viewport flex layout instead
       of Pico's default centered-document layout, plus chart-specific
       custom widgets (panels, legend, tooltip, bar chart). */
    :root { color-scheme: light; --pico-font-size: 87.5%; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; padding: 0; }
    body > header { padding: 18px 28px 14px; max-width: none; border-bottom: 1px solid var(--pico-muted-border-color); flex: 0 0 auto; }
    body > header > h1 { font-size: 18px; margin: 0; --pico-typography-spacing-vertical: 0; }
    body > header .range { margin: 6px 0 0; color: var(--pico-muted-color); font-variant-numeric: tabular-nums; }
    body > main { flex: 1 1 auto; max-width: none; padding: 14px 20px 32px; display: flex; flex-direction: column; gap: 14px; }
    section.primary { display: flex; flex-direction: column; gap: 12px; min-height: 86vh; }
    section.secondary { padding-top: 32px; border-top: 1px solid var(--pico-muted-border-color); display: flex; flex-direction: column; gap: 14px; }
    section > h2 { font-size: 14px; margin: 0; --pico-typography-spacing-vertical: 0; }
    .legend { display: flex; flex-wrap: wrap; gap: 10px 22px; font-size: 13px; color: #334155; user-select: none; }
    .legend-item { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; line-height: 1.4; }
    .legend-item.muted { opacity: 0.4; }
    .legend-swatch { width: 22px; height: 2px; border-radius: 1px; flex: 0 0 auto; }
    .legend-swatch.dashed { background: repeating-linear-gradient(90deg, currentColor 0 5px, transparent 5px 9px) !important; height: 2px; }
    .panels { position: relative; flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 4px; }
    .panel { flex: 1 1 0; min-height: 0; position: relative; }
    .panel.spot { flex-grow: 1.1; }
    .panel.perp { flex-grow: 0.9; }
    .panel > .uplot-host { position: absolute; inset: 0; }
    /* Tick-count bar chart, second section. */
    .bars { display: flex; flex-direction: column; gap: 6px; max-width: 760px; }
    .bar-row { display: grid; grid-template-columns: 150px 1fr 80px; gap: 14px; align-items: center; }
    .bar-label { text-align: right; font-size: 13px; color: #334155; }
    .bar-track { background: #f1f5f9; height: 16px; border-radius: 3px; overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 3px; }
    .bar-value { text-align: right; font-size: 13px; color: #0f172a; font-variant-numeric: tabular-nums; font-weight: 600; }
    /* Custom floating tooltip — one shared element across both panels. */
    .tooltip {
      position: absolute;
      pointer-events: none;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 12px 14px;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12);
      font: 13px/1.45 inherit;
      font-variant-numeric: tabular-nums;
      color: #0f172a;
      transition: opacity 0.06s ease;
      opacity: 0;
      z-index: 10;
      min-width: 250px;
    }
    .tooltip.visible { opacity: 1; }
    .tooltip .time { font-weight: 600; color: #0f172a; margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid #e2e8f0; }
    .tooltip .row { display: grid; grid-template-columns: 12px 1fr auto; gap: 10px; align-items: center; padding: 3px 0; }
    .tooltip .swatch { width: 10px; height: 10px; border-radius: 2px; }
    .tooltip .swatch.dashed { background: repeating-linear-gradient(90deg, currentColor 0 3px, transparent 3px 5px) !important; height: 2px; align-self: center; }
    .tooltip .name { color: #334155; font-weight: 500; }
    .tooltip .price { color: #0f172a; font-weight: 600; }
    .uplot, .u-wrap { background: transparent; }
    .u-legend { display: none !important; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(title)}</h1>
  </header>
  <main>
    <section class="primary">
      <div id="legend" class="legend"></div>
      <div class="panels">
        <div class="panel spot"><div id="chart-spot" class="uplot-host"></div></div>
        <div class="panel perp"><div id="chart-perp" class="uplot-host"></div></div>
        <div id="tooltip" class="tooltip"></div>
      </div>
    </section>
    <section class="secondary">
      <h2>Ticks captured per source</h2>
      <div id="bars" class="bars"></div>
    </section>
  </main>
  <script>
    const spotPanel = ${JSON.stringify(panels.spot)};
    const perpPanel = ${JSON.stringify(panels.perp)};
    const xs = ${JSON.stringify(panels.xs)};
    const tickCountsByLabel = ${JSON.stringify(tickCountsByExchange)};
    const tickCountBars = ${JSON.stringify(tickCountBars)};
    const priceFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const priceFormatterCompact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });
    const tooltipTimeFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const formatTime = (msUnix) => {
      const d = new Date(msUnix * 1000);
      const hms = tooltipTimeFormatter.format(d);
      const ms = String(d.getUTCMilliseconds()).padStart(3, "0");
      return hms + "." + ms + " ET";
    };

    const panelsEl = document.querySelector(".panels");
    const tooltipEl = document.getElementById("tooltip");
    const legendEl = document.getElementById("legend");
    const spotHost = document.getElementById("chart-spot");
    const perpHost = document.getElementById("chart-perp");
    const muted = new Set();

    function buildSeriesConfig(meta) {
      return [{}].concat(meta.map((m) => ({
        label: m.label,
        stroke: m.stroke,
        width: m.width,
        dash: m.dash ? [8, 4] : undefined,
        alpha: m.alpha != null ? m.alpha : 1,
        points: { show: false },
        spanGaps: false,
      })));
    }

    const easternHmsFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const easternHmFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    function makeAxes(showXLabels) {
      return [
        {
          stroke: "#64748b",
          font: "13px -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
          grid: { show: false },
          ticks: { stroke: "#cbd5e1", width: 1, size: 6 },
          show: showXLabels,
          // Minimum pixel gap between x-axis ticks. uPlot picks a tick
          // density that keeps adjacent labels at least this far apart, so
          // longer captures naturally end up with fewer (less cramped)
          // labels rather than crammed HH:MM:SS strings on top of each
          // other. uPlot doesn't natively rotate labels.
          space: 110,
          values: (u, splits) => {
            // If ticks are at least a minute apart, drop the seconds —
            // "13:55" reads cleaner than "13:55:00" at lower density.
            const incr = splits.length > 1
              ? splits[1] - splits[0]
              : Number.POSITIVE_INFINITY;
            const formatter = incr >= 60
              ? easternHmFormatter
              : easternHmsFormatter;
            return splits.map((s) => formatter.format(new Date(s * 1000)));
          },
        },
        {
          stroke: "#64748b",
          font: "13px -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
          grid: { show: false },
          ticks: { show: false },
          values: (u, splits) => splits.map((v) => priceFormatterCompact.format(v)),
          size: 92,
        },
      ];
    }

    const spotData = [xs].concat(spotPanel.ys);
    const perpData = [xs].concat(perpPanel.ys);
    const syncKey = "alea-prices";

    const spotOpts = {
      width: spotHost.clientWidth,
      height: spotHost.clientHeight,
      padding: [12, 24, 6, 8],
      cursor: {
        points: { show: false },
        drag: { setScale: false, x: false, y: false },
        focus: { prox: 1e9 },
        sync: { key: syncKey },
      },
      legend: { show: false },
      series: buildSeriesConfig(spotPanel.meta),
      axes: makeAxes(false),
      hooks: { setCursor: [onCursor("spot")] },
    };
    const perpOpts = {
      width: perpHost.clientWidth,
      height: perpHost.clientHeight,
      padding: [6, 24, 8, 8],
      cursor: {
        points: { show: false },
        drag: { setScale: false, x: false, y: false },
        focus: { prox: 1e9 },
        sync: { key: syncKey },
      },
      legend: { show: false },
      series: buildSeriesConfig(perpPanel.meta),
      axes: makeAxes(true),
      hooks: { setCursor: [onCursor("perp")] },
    };

    const spotChart = new uPlot(spotOpts, spotData, spotHost);
    const perpChart = new uPlot(perpOpts, perpData, perpHost);

    function onCursor(which) {
      return function (u) {
        const idx = u.cursor.idx;
        if (idx == null) {
          tooltipEl.classList.remove("visible");
          return;
        }
        const xVal = u.data[0][idx];
        const allMeta = spotPanel.meta.concat(perpPanel.meta);
        const allSeriesData = [];
        for (let i = 0; i < spotPanel.ys.length; i += 1) allSeriesData.push(spotPanel.ys[i]);
        for (let i = 0; i < perpPanel.ys.length; i += 1) allSeriesData.push(perpPanel.ys[i]);
        const rows = [];
        for (let i = 0; i < allMeta.length; i += 1) {
          const m = allMeta[i];
          if (muted.has(m.label)) continue;
          const y = allSeriesData[i][idx];
          if (y == null) continue;
          const swatchClass = m.dash ? "swatch dashed" : "swatch";
          const swatchStyle = m.dash ? "color:" + m.stroke : "background:" + m.stroke;
          rows.push({
            priority: m.priority,
            price: y,
            html: '<div class="row">'
              + '<span class="' + swatchClass + '" style="' + swatchStyle + '"></span>'
              + '<span class="name">' + m.label + '</span>'
              + '<span class="price">' + priceFormatter.format(y) + '</span>'
              + '</div>',
          });
        }
        rows.sort((a, b) => (b.priority - a.priority) || (b.price - a.price));
        tooltipEl.innerHTML = '<div class="time">' + formatTime(xVal) + '</div>' + rows.map((r) => r.html).join("");

        // Pin the tooltip to whichever side is opposite the cursor so it
        // never overlaps the data region the user is examining. Vertical
        // pin to top of the panels container.
        const host = which === "spot" ? spotHost : perpHost;
        const hostRect = host.getBoundingClientRect();
        const wrapRect = panelsEl.getBoundingClientRect();
        const cursorXInWrap = (hostRect.left - wrapRect.left) + u.cursor.left;
        const halfwayX = wrapRect.width / 2;
        const ttW = tooltipEl.offsetWidth;
        const margin = 12;
        const left = cursorXInWrap < halfwayX
          ? wrapRect.width - ttW - margin
          : margin;
        tooltipEl.style.left = left + "px";
        tooltipEl.style.top = margin + "px";
        tooltipEl.classList.add("visible");
      };
    }

    // VWAPs first, then everything else descending by tick count.
    const allMeta = spotPanel.meta.concat(perpPanel.meta);
    const aggregateLabels = new Set(["spot vwap", "perp vwap"]);
    const orderedMeta = [
      ...allMeta.filter((m) => aggregateLabels.has(m.label))
        .sort((a, b) => a.label.localeCompare(b.label)),
      ...allMeta.filter((m) => !aggregateLabels.has(m.label))
        .sort((a, b) => (tickCountsByLabel[b.label] ?? 0) - (tickCountsByLabel[a.label] ?? 0)),
    ];

    function renderLegend() {
      legendEl.innerHTML = orderedMeta.map((m) => {
        const muteClass = muted.has(m.label) ? " muted" : "";
        const swatchClass = m.dash ? "legend-swatch dashed" : "legend-swatch";
        const swatchStyle = m.dash ? "color:" + m.stroke : "background:" + m.stroke;
        return '<span class="legend-item' + muteClass + '" data-label="' + m.label + '">'
          + '<span class="' + swatchClass + '" style="' + swatchStyle + '"></span>'
          + m.label
          + '</span>';
      }).join("");
    }
    renderLegend();

    function renderBars() {
      const barsEl = document.getElementById("bars");
      if (!barsEl) return;
      const max = tickCountBars.reduce((m, b) => Math.max(m, b.count), 0) || 1;
      barsEl.innerHTML = tickCountBars.map((b) => {
        const widthPct = (b.count / max) * 100;
        return '<div class="bar-row">'
          + '<span class="bar-label">' + b.label + '</span>'
          + '<div class="bar-track"><div class="bar-fill" style="width:' + widthPct.toFixed(2) + '%;background:' + b.stroke + '"></div></div>'
          + '<span class="bar-value">' + b.count.toLocaleString() + '</span>'
          + '</div>';
      }).join("");
    }
    renderBars();
    legendEl.addEventListener("click", (e) => {
      const target = e.target.closest(".legend-item");
      if (!target) return;
      const label = target.getAttribute("data-label");
      const findIdx = (meta) => meta.findIndex((m) => m.label === label) + 1;
      const spotIdx = findIdx(spotPanel.meta);
      const perpIdx = findIdx(perpPanel.meta);
      if (muted.has(label)) {
        muted.delete(label);
        if (spotIdx > 0) spotChart.setSeries(spotIdx, { show: true });
        if (perpIdx > 0) perpChart.setSeries(perpIdx, { show: true });
      } else {
        muted.add(label);
        if (spotIdx > 0) spotChart.setSeries(spotIdx, { show: false });
        if (perpIdx > 0) perpChart.setSeries(perpIdx, { show: false });
      }
      renderLegend();
    });

    function resize() {
      spotChart.setSize({ width: spotHost.clientWidth, height: spotHost.clientHeight });
      perpChart.setSize({ width: perpHost.clientWidth, height: perpHost.clientHeight });
    }
    window.addEventListener("resize", resize);
    panelsEl.addEventListener("mouseleave", () => tooltipEl.classList.remove("visible"));
  </script>
</body>
</html>
`;
}

const gridBinMs = 100;
const polymarketLineWidth = 3.25;
const defaultLineWidth = 1.25;
const uniformLineWidth = 1.5;
const exchangeLineOpacity = 0.4;
const consensusLineWidth = 2;
const spotConsensusColor = "#0f172a";
const perpConsensusColor = "#3730a3";

const colorByExchange: Record<ExchangeId, string> = {
  "coinbase-spot": "#0052ff",
  "coinbase-perp": "#003ec1",
  "binance-spot": "#f0b90b",
  "binance-perp": "#a37c08",
  "bybit-spot": "#ff8533",
  "bybit-perp": "#c25d1a",
  "okx-spot": "#475569",
  "okx-swap": "#1f2937",
  "bitstamp-spot": "#00b873",
  "gemini-spot": "#0aa6a8",
  "polymarket-chainlink": "#ff1744",
};

const shortLabelByExchange: Record<ExchangeId, string> = {
  "coinbase-spot": "coinbase",
  "coinbase-perp": "coinbase-perp",
  "binance-spot": "binance",
  "binance-perp": "binance-perp",
  "bybit-spot": "bybit",
  "bybit-perp": "bybit-perp",
  "okx-spot": "okx",
  "okx-swap": "okx-swap",
  "bitstamp-spot": "bitstamp",
  "gemini-spot": "gemini",
  "polymarket-chainlink": "polymarket",
};

const spotVenues: readonly ExchangeId[] = [
  "binance-spot",
  "bitstamp-spot",
  "bybit-spot",
  "coinbase-spot",
  "gemini-spot",
  "okx-spot",
];
const perpVenues: readonly ExchangeId[] = [
  "binance-perp",
  "coinbase-perp",
  "bybit-perp",
  "okx-swap",
];
const polymarketKey: ExchangeId = "polymarket-chainlink";

type SeriesMeta = {
  readonly label: string;
  readonly stroke: string;
  readonly width: number;
  readonly alpha: number;
  readonly dash: boolean;
  readonly priority: number;
};

type PanelData = {
  readonly meta: readonly SeriesMeta[];
  readonly ys: readonly (readonly (number | null)[])[];
};

type AllPanelsData = {
  readonly xs: readonly number[];
  readonly spot: PanelData;
  readonly perp: PanelData;
};

function buildGrid({
  startedAtMs,
  endedAtMs,
  binMs,
}: {
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly binMs: number;
}): number[] {
  const aligned = Math.floor(startedAtMs / binMs) * binMs;
  const grid: number[] = [];
  for (let t = aligned; t <= endedAtMs; t += binMs) {
    grid.push(t);
  }
  return grid;
}

function groupTicksByExchange({
  ticks,
}: {
  readonly ticks: readonly QuoteTick[];
}): Map<ExchangeId, QuoteTick[]> {
  const out = new Map<ExchangeId, QuoteTick[]>();
  for (const tick of ticks) {
    const list = out.get(tick.exchange) ?? [];
    list.push(tick);
    out.set(tick.exchange, list);
  }
  return out;
}

function buildPanelData({
  ticksByExchange,
  grid,
  exhaustive,
}: {
  readonly ticksByExchange: ReadonlyMap<ExchangeId, readonly QuoteTick[]>;
  readonly grid: readonly number[];
  readonly exhaustive: boolean;
}): AllPanelsData {
  const xs = grid.map((ms) => ms / 1000);

  const interpolatedByExchange = new Map<ExchangeId, Array<number | null>>();
  for (const [exchange, ticks] of ticksByExchange) {
    interpolatedByExchange.set(
      exchange,
      interpolateMidsAtTimestamps({ ticks, timestampsMs: grid }),
    );
  }

  const venueWidth = exhaustive ? defaultLineWidth : uniformLineWidth;
  const venueAlpha = exhaustive ? exchangeLineOpacity : 1;

  const spotMeta: SeriesMeta[] = [];
  const spotYs: Array<readonly (number | null)[]> = [];
  for (const exchange of spotVenues) {
    if (!ticksByExchange.has(exchange)) {
      continue;
    }
    const interp = interpolatedByExchange.get(exchange);
    if (!interp) {
      continue;
    }
    spotMeta.push({
      label: shortLabelByExchange[exchange],
      stroke: colorByExchange[exchange],
      width: venueWidth,
      alpha: venueAlpha,
      dash: false,
      priority: 0,
    });
    spotYs.push(interp);
  }
  if (exhaustive) {
    spotMeta.push({
      label: "spot vwap",
      stroke: spotConsensusColor,
      width: consensusLineWidth,
      alpha: 1,
      dash: true,
      priority: 5,
    });
    spotYs.push(
      computeConsensusOnGrid({
        grid,
        interpolatedByExchange,
        weights: exchangeSpotVolumeWeights,
      }),
    );
  }
  if (ticksByExchange.has(polymarketKey)) {
    const interp = interpolatedByExchange.get(polymarketKey);
    if (interp) {
      // Polymarket is always emphasized — it's the focal series in both
      // default and exhaustive modes.
      spotMeta.push({
        label: shortLabelByExchange[polymarketKey],
        stroke: colorByExchange[polymarketKey],
        width: polymarketLineWidth,
        alpha: 1,
        dash: false,
        priority: 10,
      });
      spotYs.push(interp);
    }
  }

  const perpMeta: SeriesMeta[] = [];
  const perpYs: Array<readonly (number | null)[]> = [];
  for (const exchange of perpVenues) {
    if (!ticksByExchange.has(exchange)) {
      continue;
    }
    const interp = interpolatedByExchange.get(exchange);
    if (!interp) {
      continue;
    }
    perpMeta.push({
      label: shortLabelByExchange[exchange],
      stroke: colorByExchange[exchange],
      width: venueWidth,
      alpha: venueAlpha,
      dash: false,
      priority: 0,
    });
    perpYs.push(interp);
  }
  if (exhaustive) {
    perpMeta.push({
      label: "perp vwap",
      stroke: perpConsensusColor,
      width: consensusLineWidth,
      alpha: 1,
      dash: true,
      priority: 5,
    });
    perpYs.push(
      computeConsensusOnGrid({
        grid,
        interpolatedByExchange,
        weights: exchangePerpVolumeWeights,
      }),
    );
  }

  return {
    xs,
    spot: { meta: spotMeta, ys: spotYs },
    perp: { meta: perpMeta, ys: perpYs },
  };
}

function computeConsensusOnGrid({
  grid,
  interpolatedByExchange,
  weights,
}: {
  readonly grid: readonly number[];
  readonly interpolatedByExchange: ReadonlyMap<
    ExchangeId,
    ReadonlyArray<number | null>
  >;
  readonly weights: Partial<Record<ExchangeId, number>>;
}): Array<number | null> {
  const out: Array<number | null> = [];
  for (let i = 0; i < grid.length; i += 1) {
    let weightedSum = 0;
    let weightSum = 0;
    for (const [exchange, w] of Object.entries(weights) as [
      ExchangeId,
      number,
    ][]) {
      if (!w || w <= 0) {
        continue;
      }
      const series = interpolatedByExchange.get(exchange);
      const v = series?.[i];
      if (v == null) {
        continue;
      }
      weightedSum += w * v;
      weightSum += w;
    }
    out.push(weightSum > 0 ? weightedSum / weightSum : null);
  }
  return out;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function countTicksByExchange({
  ticksByExchange,
}: {
  readonly ticksByExchange: ReadonlyMap<ExchangeId, readonly QuoteTick[]>;
}): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [exchange, list] of ticksByExchange) {
    out[shortLabelByExchange[exchange]] = list.length;
  }
  return out;
}

type TickCountBar = {
  readonly label: string;
  readonly count: number;
  readonly stroke: string;
};

function buildTickCountBars({
  tickCountsByExchange,
}: {
  readonly tickCountsByExchange: Record<string, number>;
}): TickCountBar[] {
  const labelToExchange = new Map<string, ExchangeId>();
  for (const [exchange, label] of Object.entries(shortLabelByExchange) as [
    ExchangeId,
    string,
  ][]) {
    labelToExchange.set(label, exchange);
  }
  return Object.entries(tickCountsByExchange)
    .map(([label, count]) => {
      const exchange = labelToExchange.get(label);
      const stroke = exchange ? colorByExchange[exchange] : "#94a3b8";
      return { label, count, stroke };
    })
    .sort((a, b) => b.count - a.count);
}
