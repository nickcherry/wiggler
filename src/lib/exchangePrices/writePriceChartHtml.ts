import { writeFile } from "node:fs/promises";

import { renderPriceChartHtml } from "@wiggler/lib/exchangePrices/renderPriceChartHtml";
import type { ExchangeId, QuoteTick } from "@wiggler/types/exchanges";

type WritePriceChartHtmlParams = {
  readonly capture: {
    readonly ticks: readonly QuoteTick[];
    readonly tickCounts: Partial<Record<ExchangeId, number>>;
    readonly startedAtMs: number;
    readonly endedAtMs: number;
    readonly exhaustive?: boolean;
  };
  readonly htmlPath: string;
};

/**
 * Renders the HTML chart for a capture and writes it to disk. Accepts the
 * structural superset of both `QuoteCapture` (loaded from disk) and
 * `CaptureAllQuoteStreamsResult` (live) so it can be called from either path.
 *
 * `exhaustive` controls chart presentation:
 *   - true  → fade venue lines, emphasize polymarket, draw spot/perp VWAPs
 *   - false → uniform line styling across every series, no VWAPs (the
 *             default `latency:capture` shape).
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
    exhaustive: capture.exhaustive ?? false,
  });
  await writeFile(htmlPath, html);
}
