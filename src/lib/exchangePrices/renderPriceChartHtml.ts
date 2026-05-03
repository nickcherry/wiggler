import { computeConsensusMidSeries } from "@wiggler/lib/exchangePrices/computeConsensusMidSeries";
import { densifyMidsLinearly } from "@wiggler/lib/exchangePrices/densifyMidsLinearly";
import { exchangePerpVolumeWeights } from "@wiggler/lib/exchangePrices/exchangePerpVolumeWeights";
import { exchangeSpotVolumeWeights } from "@wiggler/lib/exchangePrices/exchangeSpotVolumeWeights";
import type { ExchangeId, QuoteTick } from "@wiggler/types/exchanges";

type RenderPriceChartHtmlParams = {
  readonly ticks: readonly QuoteTick[];
  readonly tickCounts: Record<ExchangeId, number>;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
};

/**
 * Renders a self-contained light-themed HTML chart of mid-price BBO ticks
 * per exchange using Plotly. Plain straight lines so close-clustered
 * exchanges read as smooth bands. Hovering surfaces one row per exchange
 * via Plotly's "x unified" tooltip (which natively dedupes per-trace at
 * the cursor's x).
 *
 * `tickCounts` is no longer rendered in the page — it lives in the JSON
 * snapshot for anyone who needs the underlying numbers — so the chart
 * stays uncluttered.
 */
export function renderPriceChartHtml({
  ticks,
  startedAtMs,
  endedAtMs,
}: RenderPriceChartHtmlParams): string {
  const exchangeTraces = buildExchangeTraces({ ticks });
  const spotConsensusTrace = buildConsensusTrace({
    name: "spot vwap",
    color: spotConsensusColor,
    points: computeConsensusMidSeries({
      ticks,
      weights: exchangeSpotVolumeWeights,
      binMs: consensusBinMs,
    }),
  });
  const perpConsensusTrace = buildConsensusTrace({
    name: "perp vwap",
    color: perpConsensusColor,
    points: computeConsensusMidSeries({
      ticks,
      weights: exchangePerpVolumeWeights,
      binMs: consensusBinMs,
    }),
  });
  // Order matters: traces later in the array render on top of earlier ones.
  // Polymarket and the consensus lines should sit above the venue traces.
  const traces = [...exchangeTraces.others, spotConsensusTrace, perpConsensusTrace, ...exchangeTraces.polymarket];

  const range = `${new Date(startedAtMs).toISOString()} → ${new Date(endedAtMs).toISOString()}`;
  const title = "Wiggler price capture";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(`${title} — ${range}`)}</title>
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js" charset="utf-8"></script>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; height: 100%; background: #ffffff; color: #0f172a; font: 12px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
    body { display: flex; flex-direction: column; min-height: 100vh; }
    header { padding: 16px 24px 12px; border-bottom: 1px solid #e2e8f0; flex: 0 0 auto; }
    header h1 { font-size: 12px; font-weight: 600; margin: 0; color: #0f172a; letter-spacing: 0.01em; }
    header .range { margin: 3px 0 0; color: #475569; font-size: 10px; font-variant-numeric: tabular-nums; }
    main { flex: 1 1 auto; min-height: 0; padding: 8px 16px 16px; }
    #chart { width: 100%; height: 100%; }
    /* Plotly's unified hover: thicken the drop-shadow and round corners
       so the card has visible breathing room around the cramped text. */
    .hovertext text { font-family: inherit !important; }
    .hovertext > path,
    .hovertext > rect { filter: drop-shadow(0 8px 24px rgba(15, 23, 42, 0.12)); }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(title)}</h1>
    <p class="range">${escapeHtml(range)}</p>
  </header>
  <main><div id="chart"></div></main>
  <script>
    const traces = ${JSON.stringify(traces)};
    const layout = {
      paper_bgcolor: "#ffffff",
      plot_bgcolor: "#ffffff",
      font: { family: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif", color: "#0f172a", size: 10 },
      margin: { l: 72, r: 24, t: 44, b: 48 },
      showlegend: true,
      legend: {
        orientation: "h",
        y: 1.06,
        x: 0,
        xanchor: "left",
        yanchor: "bottom",
        bgcolor: "rgba(255,255,255,0)",
        font: { color: "#334155", size: 10 },
      },
      hovermode: "x unified",
      hoverlabel: {
        bgcolor: "#ffffff",
        bordercolor: "#e2e8f0",
        // The hoverlabel rect sizes to text bbox plus a small fixed margin.
        // Bump font size + nbsp padding in templates to widen the breathing
        // room around each row; this is the only Plotly knob for it.
        font: { color: "#0f172a", size: 12, family: "inherit" },
        align: "left",
        namelength: -1,
      },
      xaxis: {
        type: "date",
        showline: true,
        linecolor: "#cbd5e1",
        tickfont: { color: "#64748b", size: 10 },
        tickformat: "%H:%M:%S",
        gridcolor: "#f1f5f9",
        zeroline: false,
        showspikes: false,
        hoverformat: "%H:%M:%S.%L UTC",
      },
      yaxis: {
        showline: false,
        tickfont: { color: "#64748b", size: 10 },
        gridcolor: "#f1f5f9",
        zeroline: false,
        tickformat: "$,.0f",
        hoverformat: "$,.2f",
      },
    };
    const config = {
      responsive: true,
      displaylogo: false,
      displayModeBar: false,
      doubleClick: "reset",
    };
    Plotly.newPlot("chart", traces, layout, config);
    window.addEventListener("resize", () => Plotly.Plots.resize("chart"));
  </script>
</body>
</html>
`;
}

type PlotlyLineTrace = {
  readonly type: "scatter";
  readonly mode: "lines";
  readonly name: string;
  readonly x: readonly string[];
  readonly y: readonly number[];
  readonly line: {
    readonly color: string;
    readonly width: number;
    readonly shape: "linear";
    readonly dash?: "solid" | "dash";
  };
  readonly opacity?: number;
  readonly hovertemplate: string;
};

/**
 * Per-exchange palette. Each venue gets a brand-derived hue; spot uses the
 * lighter shade and perp/swap uses a darker variant of the same hue so a
 * "binance" or "bybit" pair reads as one family. polymarket-chainlink gets
 * a high-contrast accent (red) and a thicker line so it visibly stands
 * out — it's the reference price that drives Polymarket settlement, and
 * the experiment is mostly about how it tracks the underlyings.
 */
const colorByExchange: Record<ExchangeId, string> = {
  "coinbase-spot": "#0052ff",
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

const exchangeLineOpacity = 0.35;

/**
 * Compact display labels for the legend and tooltip. Spot suffixes are
 * dropped (since spot is the implied default) so the legend fits on one
 * row; perp/swap suffixes are kept because the product type matters.
 */
const shortLabelByExchange: Record<ExchangeId, string> = {
  "coinbase-spot": "coinbase",
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

const polymarketLineWidth = 3.25;
const polymarketDenseBinMs = 100;
const defaultLineWidth = 1.25;
const consensusBinMs = 200;
const consensusLineWidth = 2;
const spotConsensusColor = "#0f172a";
const perpConsensusColor = "#3730a3";

function buildExchangeTraces({
  ticks,
}: {
  readonly ticks: readonly QuoteTick[];
}): { readonly others: PlotlyLineTrace[]; readonly polymarket: PlotlyLineTrace[] } {
  const ticksByExchange = new Map<ExchangeId, QuoteTick[]>();
  for (const tick of ticks) {
    const list = ticksByExchange.get(tick.exchange) ?? [];
    list.push(tick);
    ticksByExchange.set(tick.exchange, list);
  }
  const others: PlotlyLineTrace[] = [];
  const polymarket: PlotlyLineTrace[] = [];
  for (const [exchange, exchangeTicks] of [...ticksByExchange.entries()].sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    const isPolymarket = exchange === "polymarket-chainlink";
    const color = colorByExchange[exchange];
    const width = isPolymarket ? polymarketLineWidth : defaultLineWidth;
    // Polymarket-chainlink ticks at ~1 Hz while other venues fire at
    // 60–130 Hz. Linearly densify only this series onto a fast grid so
    // the unified hover finds a polymarket point near every cursor x.
    // The visual line shape is preserved exactly (linear interp between
    // the same endpoints Plotly would draw).
    const points: ReadonlyArray<readonly [number, number]> = isPolymarket
      ? densifyMidsLinearly({ ticks: exchangeTicks, binMs: polymarketDenseBinMs })
      : exchangeTicks.map((tick) => [tick.tsReceivedMs, tick.mid] as const);
    const trace: PlotlyLineTrace = {
      type: "scatter",
      mode: "lines",
      name: shortLabelByExchange[exchange],
      x: points.map(([ms]) => new Date(ms).toISOString()),
      y: points.map(([, mid]) => mid),
      line: { color, width, shape: "linear" },
      // Fade the venue traces so polymarket and the vwap lines pop. Polymarket
      // stays at full opacity since it's the focal series.
      opacity: isPolymarket ? 1 : exchangeLineOpacity,
      hovertemplate: "&nbsp;&nbsp;&nbsp;&nbsp;<b>%{fullData.name}</b>&nbsp;&nbsp;&nbsp;&nbsp;<b>%{y:$,.2f}</b>&nbsp;&nbsp;&nbsp;&nbsp;<extra></extra>",
    };
    if (isPolymarket) {
      polymarket.push(trace);
    } else {
      others.push(trace);
    }
  }
  return { others, polymarket };
}

function buildConsensusTrace({
  name,
  color,
  points,
}: {
  readonly name: string;
  readonly color: string;
  readonly points: ReadonlyArray<readonly [number, number]>;
}): PlotlyLineTrace {
  return {
    type: "scatter",
    mode: "lines",
    name,
    x: points.map(([ms]) => new Date(ms).toISOString()),
    y: points.map(([, mid]) => mid),
    line: {
      color,
      width: consensusLineWidth,
      shape: "linear",
      dash: "dash",
    },
    hovertemplate: "&nbsp;&nbsp;&nbsp;&nbsp;<b>%{fullData.name}</b>&nbsp;&nbsp;&nbsp;&nbsp;<b>%{y:$,.2f}</b>&nbsp;&nbsp;&nbsp;&nbsp;<extra></extra>",
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
