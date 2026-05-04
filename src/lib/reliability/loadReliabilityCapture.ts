import { readFile } from "node:fs/promises";

import {
  type ReliabilityCapturePayload,
  reliabilityCapturePayloadSchema,
} from "@alea/lib/reliability/types";

export async function loadReliabilityCapture({
  path,
}: {
  readonly path: string;
}): Promise<ReliabilityCapturePayload> {
  const raw = await readFile(path, "utf8");
  return reliabilityCapturePayloadSchema.parse(JSON.parse(raw));
}
