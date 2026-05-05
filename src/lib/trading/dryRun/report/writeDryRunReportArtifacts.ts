import { writeFile } from "node:fs/promises";

import { renderDryRunReportHtml } from "@alea/lib/trading/dryRun/report/renderDryRunReportHtml";
import type { DryRunReportPayload } from "@alea/lib/trading/dryRun/report/types";

export async function writeDryRunReportArtifacts({
  payload,
  htmlPath,
  jsonPath,
}: {
  readonly payload: DryRunReportPayload;
  readonly htmlPath: string;
  readonly jsonPath: string;
}): Promise<void> {
  await Promise.all([
    writeFile(htmlPath, renderDryRunReportHtml({ payload }), "utf8"),
    writeFile(jsonPath, JSON.stringify(payload, null, 2), "utf8"),
  ]);
}
