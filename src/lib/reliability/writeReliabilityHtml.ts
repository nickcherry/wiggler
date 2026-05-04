import { writeFile } from "node:fs/promises";

import { renderReliabilityHtml } from "@alea/lib/reliability/renderReliabilityHtml";
import type { ReliabilityCapturePayload } from "@alea/lib/reliability/types";

export async function writeReliabilityHtml({
  payload,
  htmlPath,
}: {
  readonly payload: ReliabilityCapturePayload;
  readonly htmlPath: string;
}): Promise<void> {
  await writeFile(htmlPath, renderReliabilityHtml({ payload }), "utf8");
}
