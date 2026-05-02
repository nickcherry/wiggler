import type { ExchangeId, QuoteTick } from "@wiggler/types/exchanges";

type RenderPriceChartHtmlParams = {
  readonly ticks: readonly QuoteTick[];
  readonly tickCounts: Record<ExchangeId, number>;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
};

/**
 * Renders a self-contained dark-themed HTML chart of mid-price BBO ticks per
 * exchange using Apache ECharts. One step-line series per exchange, x-axis
 * is wall time, y-axis is mid (USD). A bottom data-zoom slider plus inside
 * wheel-zoom let you pan a slice; a single axis-tooltip surfaces every
 * series' mid at the cursor's x.
 */
export function renderPriceChartHtml({
  ticks,
  tickCounts,
  startedAtMs,
  endedAtMs,
}: RenderPriceChartHtmlParams): string {
  const series = buildSeries({ ticks });
  const summary = Object.entries(tickCounts)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([exchange, count]) => `${exchange}: ${count}`)
    .join("  ·  ");
  const title = `Wiggler price capture — ${formatRange({
    startedAtMs,
    endedAtMs,
  })}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"></script>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; height: 100%; background: #0b0d12; color: #e6e9ef; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
    header { padding: 16px 24px 12px; border-bottom: 1px solid #1c2030; }
    header h1 { font-size: 14px; font-weight: 600; margin: 0; letter-spacing: 0.01em; }
    header p { margin: 6px 0 0; color: #8b95a6; font-size: 12px; }
    #chart { height: calc(100vh - 76px); width: 100%; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(summary || "no ticks captured")}</p>
  </header>
  <div id="chart"></div>
  <script>
    const series = ${JSON.stringify(series)};
    const palette = [
      "#5b8def", "#f0b90b", "#22c55e", "#a855f7",
      "#06b6d4", "#ef4444", "#ec4899", "#84cc16",
      "#f97316",
    ];
    const chart = echarts.init(document.getElementById("chart"), null, { renderer: "canvas" });
    chart.setOption({
      backgroundColor: "transparent",
      animation: false,
      color: palette,
      textStyle: { color: "#e6e9ef", fontFamily: "inherit" },
      grid: { top: 30, right: 32, bottom: 90, left: 70 },
      legend: {
        top: 0,
        textStyle: { color: "#cbd5e1", fontSize: 12 },
        inactiveColor: "#3a4456",
        itemWidth: 14,
        itemHeight: 8,
      },
      tooltip: {
        trigger: "axis",
        backgroundColor: "rgba(15, 18, 26, 0.95)",
        borderColor: "#262d3d",
        textStyle: { color: "#e6e9ef" },
        valueFormatter: (v) => (typeof v === "number" ? v.toFixed(2) : v),
        axisPointer: { type: "line", lineStyle: { color: "#3a4456" } },
      },
      xAxis: {
        type: "time",
        axisLine: { lineStyle: { color: "#2a3142" } },
        axisLabel: { color: "#8b95a6" },
        splitLine: { show: true, lineStyle: { color: "#161b27" } },
      },
      yAxis: {
        type: "value",
        scale: true,
        name: "mid (USD)",
        nameTextStyle: { color: "#8b95a6", padding: [0, 0, 0, 8] },
        axisLine: { lineStyle: { color: "#2a3142" } },
        axisLabel: { color: "#8b95a6", formatter: (v) => v.toFixed(0) },
        splitLine: { show: true, lineStyle: { color: "#161b27" } },
      },
      dataZoom: [
        { type: "inside", filterMode: "filter" },
        {
          type: "slider",
          height: 30,
          bottom: 24,
          backgroundColor: "#0e1320",
          fillerColor: "rgba(91,141,239,0.14)",
          borderColor: "#1c2030",
          dataBackground: { lineStyle: { color: "#3a4456" }, areaStyle: { color: "#1c2030" } },
          handleStyle: { color: "#5b8def" },
          textStyle: { color: "#8b95a6" },
        },
      ],
      series,
    });
    window.addEventListener("resize", () => chart.resize());
  </script>
</body>
</html>
`;
}

type EchartsLineSeries = {
  readonly name: string;
  readonly type: "line";
  readonly step: "end";
  readonly showSymbol: false;
  readonly sampling: "lttb";
  readonly lineStyle: { readonly width: number };
  readonly data: ReadonlyArray<readonly [number, number]>;
};

function buildSeries({
  ticks,
}: {
  readonly ticks: readonly QuoteTick[];
}): EchartsLineSeries[] {
  const groups = new Map<string, [number, number][]>();
  for (const tick of ticks) {
    const points = groups.get(tick.exchange) ?? [];
    points.push([tick.tsReceivedMs, tick.mid]);
    groups.set(tick.exchange, points);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([exchange, points]): EchartsLineSeries => ({
        name: `${exchange} (n=${points.length})`,
        type: "line",
        step: "end",
        showSymbol: false,
        sampling: "lttb",
        lineStyle: { width: 1.5 },
        data: points,
      }),
    );
}

function formatRange({
  startedAtMs,
  endedAtMs,
}: {
  readonly startedAtMs: number;
  readonly endedAtMs: number;
}): string {
  return `${new Date(startedAtMs).toISOString()} → ${new Date(endedAtMs).toISOString()}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
