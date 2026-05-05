import { readFile, rename } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import type { DatabaseClient } from "@alea/lib/db/types";
import type { CaptureRecord } from "@alea/lib/marketCapture/types";

/**
 * Default chunk size for the bulk INSERT path. Postgres's parameter
 * limit is 65,535 per query; with 7 columns per row, a 1,000-row chunk
 * uses 7,000 parameters — comfortably under the cap and small enough
 * that a single failed batch is recoverable. Empirically 1,000 also
 * gets near-peak throughput on typical Postgres settings without any
 * tuning.
 */
const DEFAULT_INSERT_CHUNK_SIZE = 1_000;

/**
 * Suffix appended to a JSONL file after it has been ingested. We do
 * NOT delete the file by default — keeping it on disk for a few days
 * is cheap insurance against schema mistakes (or against discovering
 * we needed a different normalization path). The caller can sweep
 * `.ingested` files on whatever retention schedule it likes.
 */
const INGESTED_SUFFIX = ".ingested";

export type IngestSessionJsonlParams = {
  readonly db: DatabaseClient;
  readonly path: string;
  readonly chunkSize?: number;
  /**
   * If set, after a successful ingest the file is renamed to
   * `${path}.ingested` so subsequent passes don't double-load it.
   * Default: true.
   */
  readonly markIngested?: boolean;
};

export type IngestSessionJsonlResult = {
  readonly path: string;
  readonly rowsInserted: number;
  readonly parseErrors: number;
};

/**
 * Loads one closed-session JSONL file into the `market_event` table.
 * Atomicity: each chunk is its own INSERT, so a partial failure
 * leaves earlier chunks committed. Re-running on the same file
 * without `markIngested` would double-write — the caller's
 * responsibility to coordinate. With `markIngested` the file is
 * renamed on success, which is enough idempotence for the common
 * "rerun ingester after a crash" case.
 *
 * The file is read fully into memory (one 5-minute window at our
 * expected event rates fits in tens of MB at most). If we ever need
 * to ingest much larger files, swap to a line-streaming reader; the
 * chunk loop already handles backpressure naturally.
 */
export async function ingestSessionJsonl({
  db,
  path,
  chunkSize = DEFAULT_INSERT_CHUNK_SIZE,
  markIngested = true,
}: IngestSessionJsonlParams): Promise<IngestSessionJsonlResult> {
  const text = await readFile(path, "utf8");
  const lines = text.split("\n");

  const rows: ReturnType<typeof recordToRow>[] = [];
  let parseErrors = 0;
  for (const line of lines) {
    if (line.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parseErrors += 1;
      continue;
    }
    if (!isCaptureRecord(parsed)) {
      parseErrors += 1;
      continue;
    }
    rows.push(recordToRow(parsed));
  }

  let rowsInserted = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    if (chunk.length === 0) {
      continue;
    }
    await db.insertInto("market_event").values(chunk).execute();
    rowsInserted += chunk.length;
  }

  if (markIngested) {
    const renamed = resolvePath(`${path}${INGESTED_SUFFIX}`);
    await rename(path, renamed);
  }

  return { path, rowsInserted, parseErrors };
}

function recordToRow(record: CaptureRecord) {
  return {
    ts_ms: record.tsMs,
    received_ms: record.receivedMs,
    source: record.source,
    asset: record.asset,
    kind: record.kind,
    market_ref: record.marketRef,
    // Kysely + pg serialise objects to JSON for jsonb columns; passing
    // through `JSON.stringify` first makes the call site explicit and
    // sidesteps any per-driver `Object.toJSON` surprises in payloads.
    payload: JSON.stringify(record.payload) as unknown,
  };
}

function isCaptureRecord(value: unknown): value is CaptureRecord {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.tsMs === "number" &&
    typeof v.receivedMs === "number" &&
    typeof v.source === "string" &&
    (v.asset === null || typeof v.asset === "string") &&
    typeof v.kind === "string" &&
    (v.marketRef === null || typeof v.marketRef === "string") &&
    typeof v.payload === "object" &&
    v.payload !== null
  );
}
