import type { CaptureJsonlWriter } from "@alea/lib/marketCapture/jsonlWriter";
import type { CaptureRecord } from "@alea/lib/marketCapture/types";

/**
 * Wraps a `CaptureJsonlWriter` with the per-source non-error
 * boilerplate so subscribers can emit higher-level events (without
 * having to assemble `CaptureRecord` themselves) and the ordering
 * contract stays "if subscriber A emitted before subscriber B,
 * subscriber A's record is written first".
 *
 * Errors from `writer.write` are surfaced via `onError` and not
 * thrown back at the subscriber. A failing disk should not take down
 * the whole capture process — it should be logged and operator-
 * visible. The writer itself doesn't retry; the contract is "best
 * effort, log on failure, keep going".
 */
export type CaptureSink = (record: CaptureRecord) => void;

export function createCaptureSink({
  writer,
  onError,
}: {
  readonly writer: CaptureJsonlWriter;
  readonly onError?: (error: Error) => void;
}): CaptureSink {
  return (record) => {
    void writer.write(record).catch((error) => {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    });
  };
}
