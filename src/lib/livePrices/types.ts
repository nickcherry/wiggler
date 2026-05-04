import type { Asset } from "@alea/types/assets";

/**
 * One best-bid/best-ask update for a single asset. Drives every price-
 * conditioned decision in the live trader: distance from line, current
 * side, edge vs Polymarket.
 *
 * `mid` is materialized once on emit so call sites aren't computing
 * `(bid + ask) / 2` themselves on every tick.
 */
export type LivePriceTick = {
  readonly asset: Asset;
  readonly bid: number;
  readonly ask: number;
  readonly mid: number;
  /**
   * Exchange-side timestamp if the venue published one; otherwise null.
   * The decision loop falls back to `receivedAtMs` for staleness checks
   * when this is absent.
   */
  readonly exchangeTimeMs: number | null;
  readonly receivedAtMs: number;
};

/**
 * One CLOSED 5m bar. Emitted exactly once per `(asset, openTimeMs)` —
 * never for in-progress bars. The EMA-50 tracker rolls forward off
 * these and only these, matching the training pipeline's
 * "EMA-evaluated-just-before-the-window-starts" convention.
 */
export type ClosedFiveMinuteBar = {
  readonly asset: Asset;
  readonly openTimeMs: number;
  readonly closeTimeMs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
};

export type LivePriceFeedHandle = {
  readonly stop: () => Promise<void>;
};

/**
 * Callback bundle passed to a feed implementation. `onConnect` /
 * `onDisconnect` fire on every reconnect cycle, not just the first
 * one — consumers can use them to drive a UI status indicator and to
 * trigger a fresh REST hydration of the EMA buffer after each
 * reconnect.
 */
export type LivePriceFeedCallbacks = {
  readonly onTick: (tick: LivePriceTick) => void;
  readonly onBarClose: (bar: ClosedFiveMinuteBar) => void;
  readonly onConnect?: () => void;
  readonly onDisconnect?: (reason: string) => void;
  readonly onError?: (error: Error) => void;
};

export type LivePriceFeedParams = LivePriceFeedCallbacks & {
  readonly assets: readonly Asset[];
};

/**
 * Live price feed contract. Concrete implementations decide their own
 * connection topology (one combined WS, one socket per asset, REST
 * polling fallback, etc.) and which fields of `LivePriceTick` they can
 * meaningfully populate. Reconnect/backoff policy is the
 * implementation's responsibility — callers receive a single
 * "always-on" handle.
 */
export type LivePriceFeedFactory = (
  params: LivePriceFeedParams,
) => LivePriceFeedHandle;
