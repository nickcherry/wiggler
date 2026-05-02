import { writeFile } from "node:fs/promises";
import { renderPriceChartHtml } from "@wiggler/lib/exchangePrices/renderPriceChartHtml";
import type { ExchangeId, QuoteTick } from "@wiggler/types/exchanges";

type WritePriceChartHtmlParams = {
  readonly capture: {
    readonly ticks: readonly QuoteTick[];
    readonly tickCounts: Record<ExchangeId, number>;
    readonly startedAtMs: number;
    readonly endedAtMs: number;
  };
  readonly htmlPath: string;
};

/**
 * Renders the ECharts HTML chart for a capture and writes it to disk.
 * Accepts the structural superset of both `QuoteCapture` (loaded from
 * disk, mutable arrays) and `CaptureAllQuoteStreamsResult` (live, readonly
 * arrays) so it can be called from either path.
 */
export async function writePriceChartHtml({
  capture,
  htmlPath,
}: WritePriceChartHtmlParams): Promise<void> {
  const html = renderPriceChartHtml({
    ticks: capture.ticks,
    tickCounts: capture.tickCounts,
    startedAtMs: capture.startedAtMs,
    endedAtMs: capture.endedAtMs,
  });
  await writeFile(htmlPath, html);
}
