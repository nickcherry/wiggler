import { writeFile } from "node:fs/promises";

import { renderTrainingDistributionsHtml } from "@alea/lib/training/renderTrainingDistributionsHtml";
import type { TrainingDistributionsPayload } from "@alea/lib/training/types";

/**
 * Writes the dashboard HTML and the raw-data JSON sidecar in one shot. The
 * JSON carries everything (including the per-year breakdown that the HTML
 * intentionally hides) so it can be re-rendered later or queried directly
 * without re-running the analysis.
 */
export async function writeTrainingDistributionsArtifacts({
  payload,
  htmlPath,
  jsonPath,
}: {
  readonly payload: TrainingDistributionsPayload;
  readonly htmlPath: string;
  readonly jsonPath: string;
}): Promise<void> {
  const html = renderTrainingDistributionsHtml({ payload });
  await Promise.all([
    writeFile(htmlPath, html),
    writeFile(jsonPath, JSON.stringify(payload, null, 2)),
  ]);
}
