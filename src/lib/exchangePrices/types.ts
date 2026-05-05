import type { Asset } from "@alea/types/assets";
import type { QuoteTick } from "@alea/types/exchanges";

/**
 * One CLOSED price bar emitted by a streaming source. Currently only
 * Binance (USDT-M perp + spot) emits these — they piggy-back on the
 * same WS the BBO stream uses, so the trader's EMA-50 / ATR trackers
 * can stay in lockstep with the closed-bar tape without opening a
 * second socket. Other venues' stream-starters never invoke
 * `onBarClose` and consumers should handle that case (or simply pass
 * a no-op).
 */
export type ClosedBarTick = {
  readonly exchange: string;
  readonly asset: Asset;
  readonly openTimeMs: number;
  readonly closeTimeMs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
};

/**
 * Callbacks every per-exchange stream function uses to surface quotes
 * and connection problems to the orchestrator.
 *
 * `assets` is the set of crypto assets the caller wants subscribed
 * on this WS. Defaults to `["btc"]` for backward compatibility with
 * the original latency:capture experiments — long-running consumers
 * (data:capture, the live trader) should always pass an explicit
 * list. Stream-starters whose venue doesn't support a given asset
 * surface that via `onError`.
 *
 * `onBarClose` is an optional callback for streams that also emit
 * closed price bars (Binance perp/spot, currently). Most starters
 * never invoke it; the callback is optional so legacy single-event
 * consumers don't have to plumb a no-op.
 *
 * `onConnect` / `onDisconnect` fire on EVERY successful connect /
 * close cycle once the streamer has reconnect logic — distinct from
 * `onOpen` (raw socket open, synchronous, may need to send a
 * subscribe payload).
 */
export type StreamQuotesParams = {
  readonly assets?: readonly Asset[];
  readonly onTick: (tick: QuoteTick) => void;
  readonly onError: (error: Error) => void;
  readonly onOpen?: () => void;
  readonly onClose?: () => void;
  readonly onConnect?: () => void;
  readonly onDisconnect?: (reason: string) => void;
  readonly onBarClose?: (bar: ClosedBarTick) => void;
};

/**
 * Returned from each stream-starter so callers can shut it down cleanly.
 */
export type StreamHandle = {
  readonly stop: () => Promise<void>;
};
