import { resolve as resolvePath } from "node:path";

import { defineCommand } from "@alea/lib/cli/defineCommand";
import { defineValueOption } from "@alea/lib/cli/defineValueOption";
import { createDatabase } from "@alea/lib/db/createDatabase";
import { destroyDatabase } from "@alea/lib/db/destroyDatabase";
import { ingestSessionJsonl } from "@alea/lib/marketCapture/ingestSessionJsonl";
import { defaultCaptureDir } from "@alea/lib/marketCapture/runCapture";
import { scanPendingSessions } from "@alea/lib/marketCapture/scanPendingSessions";
import pc from "picocolors";
import { z } from "zod";

const repoRoot = resolvePath(import.meta.dir, "../../..");

/**
 * One-shot recovery utility. Lists every JSONL under the capture
 * directory that hasn't been ingested yet (no `.ingested` suffix) and
 * loads them into the `market_event` table. Useful when capture was
 * run with `--no-ingest`, when the DB was down during a previous
 * capture session, or when the operator wants to retry a failed load.
 *
 * The `--active` option must match the filename (not full path) of
 * the live capture session, if any, so the ingester doesn't race the
 * writer. Pass an empty string when no capture is active.
 */
export const dataIngestPendingCommand = defineCommand({
  name: "data:ingest-pending",
  summary:
    "Bulk-load any orphaned market-capture JSONLs into the market_event table",
  description:
    "Scans the configured capture directory (default tmp/market-capture/) for `.jsonl` files that don't have a sibling `.ingested` rename, and bulk-inserts each into the market_event Postgres table. Use this after running data:capture with --no-ingest, or to recover from a DB outage during capture. The optional --active flag excludes the currently-active capture session from the scan so the ingester doesn't race a live writer.",
  options: [
    defineValueOption({
      key: "dir",
      long: "--dir",
      valueName: "PATH",
      schema: z
        .string()
        .optional()
        .describe(
          "Override the capture directory (default tmp/market-capture under the repo root).",
        ),
    }),
    defineValueOption({
      key: "active",
      long: "--active",
      valueName: "FILENAME",
      schema: z
        .string()
        .optional()
        .describe(
          "Filename (not path) of the currently-active capture session, if any. Excluded from the scan so the ingester doesn't race the writer. Pass an empty string when no capture is active.",
        ),
    }),
  ],
  examples: [
    "bun alea data:ingest-pending",
    "bun alea data:ingest-pending --dir /tmp/captures",
    "bun alea data:ingest-pending --active 2026-05-05T15-30.jsonl",
  ],
  output:
    "One line per JSONL processed: path, row count inserted, parse errors. Exits non-zero on first failed ingest so retry can happen at the operator's discretion.",
  sideEffects:
    "Reads JSONL files under the capture directory; inserts rows into the market_event Postgres table; renames each successfully-loaded file to add a `.ingested` suffix.",
  async run({ io, options }) {
    const dir = options.dir ?? defaultCaptureDir({ repoRoot });
    const activeFileName = options.active ?? "";
    const pending = await scanPendingSessions({ dir, activeFileName });
    if (pending.length === 0) {
      io.writeStdout(`${pc.dim("nothing to ingest")}\n`);
      return;
    }
    const db = createDatabase();
    try {
      for (const entry of pending) {
        try {
          const result = await ingestSessionJsonl({ db, path: entry.path });
          io.writeStdout(
            `${pc.green("ok")} ${entry.fileName} rows=${result.rowsInserted} parseErrors=${result.parseErrors}\n`,
          );
        } catch (error) {
          io.writeStdout(
            `${pc.red("err")} ${entry.fileName} ${(error as Error).message}\n`,
          );
          process.exitCode = 1;
        }
      }
    } finally {
      await destroyDatabase(db);
    }
  },
});
