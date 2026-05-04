import { writeFile } from "node:fs/promises";

import { renderTradingPerformanceHtml } from "@alea/lib/trading/performance/renderTradingPerformanceHtml";
import type { TradingPerformancePayload } from "@alea/lib/trading/performance/types";

export async function writeTradingPerformanceArtifacts({
  payload,
  htmlPath,
  jsonPath,
}: {
  readonly payload: TradingPerformancePayload;
  readonly htmlPath: string;
  readonly jsonPath: string;
}): Promise<void> {
  const html = renderTradingPerformanceHtml({ payload });
  await Promise.all([
    writeFile(htmlPath, html),
    writeFile(jsonPath, JSON.stringify(payload, null, 2)),
  ]);
}
