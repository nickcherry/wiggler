import {
  appendFile,
  type FileHandle,
  mkdir,
  open,
  writeFile,
} from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import {
  sessionForWindow,
  type WindowSession,
  windowStartFor,
} from "@alea/lib/marketCapture/session";
import type { CaptureRecord } from "@alea/lib/marketCapture/types";

/**
 * Append-only JSONL writer that rotates files at the 5-minute window
 * boundary. Designed for a long-lived capture process: holds one open
 * file handle, appends every record as it arrives, and atomically
 * rotates on the wall-clock boundary.
 *
 * Why a long-held handle (vs. open-append-close per record): at high
 * event rates the syscall cost of `open + close` per write becomes
 * noticeable, and the OS page cache batches our `write()` calls into
 * efficient flushes anyway. We do *not* explicitly fsync — durability
 * comes from session rollover (which closes the handle, forcing the
 * page cache to flush) and from the OS's own dirty-page eviction.
 *
 * Rollover semantics:
 *   1. The previous window's `.jsonl` file is closed cleanly.
 *   2. A `.jsonl.complete` sibling is created — the ingester treats
 *      this as the "ready to be loaded" marker. We do NOT rename the
 *      file itself so the path stays stable for any human or
 *      monitoring process inspecting it.
 *   3. The new window's `.jsonl` file is opened.
 *   4. The caller's `onRollover` hook is invoked (best-effort —
 *      thrown errors are logged, not propagated, so a failing
 *      ingester can't wedge capture).
 *
 * Concurrency: every public method awaits a single in-flight chain
 * to keep writes ordered. Callers can fire-and-forget `write()` and
 * trust ordering; the only awaited boundary that matters is `close()`.
 */
export type CaptureJsonlWriter = {
  readonly currentSession: () => WindowSession | null;
  readonly write: (record: CaptureRecord) => Promise<void>;
  readonly close: () => Promise<void>;
};

export type CaptureJsonlWriterParams = {
  readonly dir: string;
  readonly nowMs?: () => number;
  readonly onRollover?: (input: {
    readonly closedSession: WindowSession;
    readonly closedPath: string;
  }) => Promise<void> | void;
  readonly onError?: (error: Error) => void;
};

export async function createCaptureJsonlWriter({
  dir,
  nowMs = () => Date.now(),
  onRollover,
  onError,
}: CaptureJsonlWriterParams): Promise<CaptureJsonlWriter> {
  let handle: FileHandle | null = null;
  let session: WindowSession | null = null;
  let closed = false;
  // Single-slot serialiser so write/close/rollover can't interleave.
  let queue: Promise<void> = Promise.resolve();

  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const openSession = async (windowStartMs: number): Promise<void> => {
    const next = sessionForWindow({ windowStartMs });
    const sessionDir = resolvePath(dir, next.relativeDir);
    await mkdir(sessionDir, { recursive: true });
    const path = resolvePath(sessionDir, next.fileName);
    handle = await open(path, "a");
    session = next;
  };

  const finishSession = async (): Promise<void> => {
    const ending = session;
    const ph = handle;
    if (ending === null || ph === null) {
      return;
    }
    handle = null;
    session = null;
    try {
      await ph.close();
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
    const sessionDir = resolvePath(dir, ending.relativeDir);
    const closedPath = resolvePath(sessionDir, ending.fileName);
    const completePath = resolvePath(sessionDir, ending.completeFileName);
    try {
      // The `.complete` marker is a zero-byte sentinel; its existence
      // is the contract with the ingester. Best-effort write — a
      // disk-full scenario shouldn't take down the writer, but we
      // surface the error so the operator notices.
      await writeFile(completePath, "");
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
    if (onRollover !== undefined) {
      try {
        await onRollover({ closedSession: ending, closedPath });
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  };

  const ensureCurrentSession = async (recordTsMs: number): Promise<void> => {
    const targetWindowStart = windowStartFor({ nowMs: recordTsMs });
    if (session === null) {
      await openSession(targetWindowStart);
      return;
    }
    if (session.windowStartMs === targetWindowStart) {
      return;
    }
    await finishSession();
    await openSession(targetWindowStart);
  };

  // Open the current window up front so `currentSession()` returns a
  // valid value before the first event arrives. Useful for operator
  // visibility.
  await enqueue(async () => {
    await openSession(windowStartFor({ nowMs: nowMs() }));
  });

  return {
    currentSession: () => session,
    write: (record) =>
      enqueue(async () => {
        if (closed) {
          throw new Error("capture jsonl writer is closed");
        }
        // Route by WALL-CLOCK at write time, not by `record.tsMs`.
        //
        // We tried event-time routing first and it blew up at every
        // 5-minute boundary: cross-venue clock skew puts simultaneous
        // events on opposite sides of the wall-clock boundary (Binance
        // says 14:59:59.97, Coinbase says 15:00:00.05). Routing by each
        // event's clock causes the writer to flip-flop between two
        // windows for several seconds, triggering O(n) redundant
        // rotations and re-ingestions per boundary.
        //
        // The window a record lands in is now defined by "the wall-
        // clock window during which we observed it." `record.tsMs` is
        // still preserved verbatim in the JSONL line, so any analysis
        // that wants venue-time bucketing can re-bin from there. The
        // file's window key is operational, not analytical.
        await ensureCurrentSession(nowMs());
        if (handle === null) {
          // Defensive — `ensureCurrentSession` always sets handle.
          throw new Error("capture jsonl writer has no open handle");
        }
        const line = `${JSON.stringify(record)}\n`;
        // `appendFile` on a FileHandle writes from current position
        // (open mode 'a' positions at EOF on each write under POSIX).
        await appendFile(handle, line, "utf8");
      }),
    close: () =>
      enqueue(async () => {
        if (closed) {
          return;
        }
        closed = true;
        await finishSession();
      }),
  };
}
