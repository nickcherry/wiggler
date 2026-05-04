import { rename, writeFile } from "node:fs/promises";

import { computeReliabilitySummary } from "@alea/lib/reliability/computeReliabilitySummary";
import type { ReliabilityCapturePayload } from "@alea/lib/reliability/types";

export async function writeReliabilityCapture({
  path,
  capture,
}: {
  readonly path: string;
  readonly capture: ReliabilityCapturePayload;
}): Promise<void> {
  capture.updatedAtMs = Date.now();
  capture.summary = computeReliabilitySummary({
    completedWindows: capture.completedWindows,
    nearZeroThresholdBp: capture.nearZeroThresholdBp,
  });
  const tmpPath = `${path}.tmp-${process.pid}`;
  await writeFile(tmpPath, `${JSON.stringify(capture, null, 2)}\n`, "utf8");
  await rename(tmpPath, path);
}
