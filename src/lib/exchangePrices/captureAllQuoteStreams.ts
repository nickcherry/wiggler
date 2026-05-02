import { streamStartersByExchange } from "@wiggler/lib/exchangePrices/streamStartersByExchange";
import type { ExchangeId, QuoteTick } from "@wiggler/types/exchanges";

type CaptureAllQuoteStreamsParams = {
  readonly exchanges: readonly ExchangeId[];
  readonly durationMs: number;
  readonly onProgress?: (event: ProgressEvent) => void;
};

export type ProgressEvent =
  | { readonly kind: "open"; readonly exchange: ExchangeId }
  | { readonly kind: "close"; readonly exchange: ExchangeId }
  | {
      readonly kind: "error";
      readonly exchange: ExchangeId;
      readonly error: Error;
    };

export type CaptureAllQuoteStreamsResult = {
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly durationMs: number;
  readonly ticks: readonly QuoteTick[];
  readonly tickCounts: Record<ExchangeId, number>;
  readonly errors: ReadonlyArray<{
    readonly exchange: ExchangeId;
    readonly error: string;
  }>;
};

/**
 * Opens every requested exchange stream concurrently, accumulates quote
 * ticks for `durationMs`, then closes all streams and returns the captured
 * data. Per-exchange errors are collected rather than raised so one
 * misbehaving feed doesn't kill the run.
 */
export async function captureAllQuoteStreams({
  exchanges,
  durationMs,
  onProgress,
}: CaptureAllQuoteStreamsParams): Promise<CaptureAllQuoteStreamsResult> {
  const ticks: QuoteTick[] = [];
  const tickCounts = newTickCounts({ exchanges });
  const errors: { exchange: ExchangeId; error: string }[] = [];
  const handles: { exchange: ExchangeId; stop: () => Promise<void> }[] = [];

  for (const exchange of exchanges) {
    const start = streamStartersByExchange[exchange];
    try {
      const handle = start({
        onTick: (tick) => {
          ticks.push(tick);
          tickCounts[exchange] += 1;
        },
        onError: (error) => {
          errors.push({ exchange, error: error.message });
          onProgress?.({ kind: "error", exchange, error });
        },
        onOpen: () => onProgress?.({ kind: "open", exchange }),
        onClose: () => onProgress?.({ kind: "close", exchange }),
      });
      handles.push({ exchange, stop: handle.stop });
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      errors.push({ exchange, error: wrapped.message });
      onProgress?.({ kind: "error", exchange, error: wrapped });
    }
  }

  const startedAtMs = Date.now();
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  const endedAtMs = Date.now();

  await Promise.allSettled(handles.map((handle) => handle.stop()));

  return {
    startedAtMs,
    endedAtMs,
    durationMs,
    ticks,
    tickCounts,
    errors,
  };
}

function newTickCounts({
  exchanges,
}: {
  readonly exchanges: readonly ExchangeId[];
}): Record<ExchangeId, number> {
  const counts: Partial<Record<ExchangeId, number>> = {};
  for (const exchange of exchanges) {
    counts[exchange] = 0;
  }
  return counts as Record<ExchangeId, number>;
}
