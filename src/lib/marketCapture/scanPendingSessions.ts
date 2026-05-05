import { readdir, stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

/**
 * Discovers JSONL files under the capture directory that are eligible
 * for ingestion at process startup. There are three states a JSONL
 * can be in:
 *
 *   1. `${windowKey}.jsonl` with a `${windowKey}.jsonl.complete`
 *      sibling — the writer rotated cleanly; ready to ingest.
 *   2. `${windowKey}.jsonl` *without* a `.complete` sibling — either
 *      the active session, or a previous run was killed mid-window.
 *      Treated as ingestable IF its window is in the past (the
 *      caller has already moved past that wall-clock minute, so the
 *      file isn't going to grow further).
 *   3. `${windowKey}.jsonl.ingested` — already loaded, ignored.
 *
 * The recovery contract: at startup, scan with this function, then
 * ingest each entry (skipping the active window which the new writer
 * will handle). This way a kill -9 leaves at most one window's worth
 * of events un-loaded, and the next start picks them up automatically.
 *
 * `nowMs` is the wall-clock floor we use to decide which orphaned
 * `.jsonl` files are safely past their window. Files whose window has
 * not yet ended are skipped — the new writer is about to open them.
 */

export type PendingSession = {
  readonly path: string;
  readonly fileName: string;
  readonly hasCompleteMarker: boolean;
};

export async function scanPendingSessions({
  dir,
  activeFileName,
}: {
  readonly dir: string;
  /**
   * Filename (not full path) of the session the running writer is
   * about to open or just opened. Excluded from the result so the
   * caller doesn't try to ingest a file the writer is appending to.
   */
  readonly activeFileName: string;
}): Promise<PendingSession[]> {
  const dateDirs = await safeReaddir(dir);
  const out: PendingSession[] = [];
  for (const dateDir of dateDirs) {
    const dateDirAbsolute = resolvePath(dir, dateDir);
    const stats = await safeStat(dateDirAbsolute);
    if (stats === null || !stats.isDirectory()) {
      continue;
    }
    const entries = await safeReaddir(dateDirAbsolute);
    const completeMarkers = new Set(
      entries.filter((entry) => entry.endsWith(".jsonl.complete")),
    );
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) {
        continue;
      }
      if (entry === activeFileName) {
        continue;
      }
      out.push({
        path: resolvePath(dateDirAbsolute, entry),
        fileName: entry,
        hasCompleteMarker: completeMarkers.has(`${entry}.complete`),
      });
    }
  }
  return out;
}

async function safeReaddir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

async function safeStat(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}
