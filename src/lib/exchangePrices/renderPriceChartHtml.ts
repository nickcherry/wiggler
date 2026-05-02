import type { ExchangeId, QuoteTick } from "@wiggler/types/exchanges";

type RenderPriceChartHtmlParams = {
  readonly ticks: readonly QuoteTick[];
  readonly tickCounts: Record<ExchangeId, number>;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
};

/**
 * Renders a self-contained HTML file with one Plotly trace per exchange,
 * showing the mid-price line as a step plot. Plotly is loaded from CDN —
 * the file is small, but requires internet to view.
 *
 * Each exchange's trace has its own consistent color so visual comparison
 * across exchanges is easy. Hover surfaces the exchange, mid, bid, and ask.
 */
export function renderPriceChartHtml({
  ticks,
  tickCounts,
  startedAtMs,
  endedAtMs,
}: RenderPriceChartHtmlParams): string {
  const byExchange = groupByExchange({ ticks });
  const traces = Object.entries(byExchange).map(([exchange, rows]) => ({
    type: "scatter" as const,
    mode: "lines" as const,
    name: `${exchange} (n=${rows.length})`,
    line: { shape: "hv" as const, width: 1.5 },
    x: rows.map((r) => new Date(r.tsReceivedMs).toISOString()),
    y: rows.map((r) => r.mid),
    customdata: rows.map((r) => [r.bid, r.ask]),
    hovertemplate:
      "<b>%{fullData.name}</b><br>" +
      "ts: %{x}<br>" +
      "mid: %{y:.2f}<br>" +
      "bid: %{customdata[0]:.2f}<br>" +
      "ask: %{customdata[1]:.2f}<extra></extra>",
  }));

  const summary = Object.entries(tickCounts)
    .filter(([, count]) => count > 0)
    .map(([exchange, count]) => `${exchange}: ${count}`)
    .join("  ·  ");

  const escapedTitle = `Wiggler price capture — ${formatRange({
    startedAtMs,
    endedAtMs,
  })}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapedTitle}</title>
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js" charset="utf-8"></script>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; font: 14px/1.4 system-ui, -apple-system, sans-serif; background: #0b0d12; color: #e6e9ef; }
    header { padding: 12px 20px; border-bottom: 1px solid #1c2030; }
    header h1 { font-size: 16px; font-weight: 600; margin: 0; }
    header p { margin: 4px 0 0; color: #98a2b3; font-size: 12px; }
    #chart { height: calc(100vh - 64px); }
  </style>
</head>
<body>
  <header>
    <h1>${escapedTitle}</h1>
    <p>${summary || "no ticks captured"}</p>
  </header>
  <div id="chart"></div>
  <script>
    const traces = ${JSON.stringify(traces)};
    Plotly.newPlot("chart", traces, {
      paper_bgcolor: "#0b0d12",
      plot_bgcolor: "#0b0d12",
      font: { color: "#e6e9ef", family: "system-ui" },
      margin: { l: 60, r: 20, t: 20, b: 60 },
      xaxis: { gridcolor: "#1c2030", zerolinecolor: "#1c2030", title: "time (UTC)" },
      yaxis: { gridcolor: "#1c2030", zerolinecolor: "#1c2030", title: "mid price (USD)" },
      legend: { bgcolor: "rgba(0,0,0,0)" },
      hovermode: "x unified",
    }, { responsive: true, displaylogo: false });
  </script>
</body>
</html>
`;
}

function groupByExchange({
  ticks,
}: {
  readonly ticks: readonly QuoteTick[];
}): Record<string, QuoteTick[]> {
  const groups: Record<string, QuoteTick[]> = {};
  for (const tick of ticks) {
    const key = tick.exchange;
    if (!groups[key]) groups[key] = [];
    groups[key].push(tick);
  }
  return groups;
}

function formatRange({
  startedAtMs,
  endedAtMs,
}: {
  readonly startedAtMs: number;
  readonly endedAtMs: number;
}): string {
  const start = new Date(startedAtMs).toISOString();
  const end = new Date(endedAtMs).toISOString();
  return `${start} → ${end}`;
}
