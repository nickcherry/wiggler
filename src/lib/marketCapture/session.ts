import { FIVE_MINUTES_MS } from "@alea/lib/livePrices/fiveMinuteWindow";

/**
 * Per-window file naming utilities. The capture pipeline uses 5-minute
 * windows that align with the trading runner's window boundaries, so
 * a JSONL file holds exactly one window's worth of events and the
 * filename is enough to identify the window.
 *
 * Files are sharded by date (YYYY-MM-DD subdirectory) to keep any one
 * directory under a few hundred entries per day even when capturing
 * for weeks at a time. ext4/APFS handle large directories fine but
 * `ls` and tab-completion start to choke past a few thousand entries.
 *
 * `windowKey` is the canonical wall-clock string for the window — the
 * UTC start time formatted to minute granularity. It's also the
 * filename stem, so the file path round-trips through this module.
 *
 * The convention for "still being written" is a `.jsonl` suffix; the
 * convention for "closed and ready to ingest" is a `.jsonl.complete`
 * sibling. Using a separate marker file (rather than renaming) keeps
 * the rotation atomic with respect to writers — the writer never has
 * to seek back to the file it just closed, and the ingester never
 * has to wait for a rename to land before reading.
 */

export type WindowSession = {
  readonly windowStartMs: number;
  readonly windowKey: string;
  readonly relativeDir: string;
  readonly fileName: string;
  readonly completeFileName: string;
};

/**
 * Floors `nowMs` to its 5-minute window start, the same convention
 * the trading runner uses (see `currentWindowStartMs`).
 */
export function windowStartFor({ nowMs }: { readonly nowMs: number }): number {
  return Math.floor(nowMs / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
}

/**
 * Builds the full `WindowSession` descriptor for the given window
 * start. All three properties are derivable from `windowStartMs`
 * alone — bundling them at the boundary keeps file-naming logic out
 * of the writer/ingester.
 */
export function sessionForWindow({
  windowStartMs,
}: {
  readonly windowStartMs: number;
}): WindowSession {
  const date = new Date(windowStartMs);
  const yyyy = date.getUTCFullYear().toString().padStart(4, "0");
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = date.getUTCDate().toString().padStart(2, "0");
  const hh = date.getUTCHours().toString().padStart(2, "0");
  const mi = date.getUTCMinutes().toString().padStart(2, "0");
  const dateDir = `${yyyy}-${mm}-${dd}`;
  const windowKey = `${dateDir}T${hh}-${mi}`;
  return {
    windowStartMs,
    windowKey,
    relativeDir: dateDir,
    fileName: `${windowKey}.jsonl`,
    completeFileName: `${windowKey}.jsonl.complete`,
  };
}
