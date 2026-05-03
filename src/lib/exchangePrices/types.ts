import type { QuoteTick } from "@alea/types/exchanges";

/**
 * Callbacks every per-exchange stream function uses to surface quotes and
 * connection problems to the orchestrator.
 */
export type StreamQuotesParams = {
  readonly onTick: (tick: QuoteTick) => void;
  readonly onError: (error: Error) => void;
  readonly onOpen?: () => void;
  readonly onClose?: () => void;
};

/**
 * Returned from each stream-starter so callers can shut it down cleanly.
 */
export type StreamHandle = {
  readonly stop: () => Promise<void>;
};
