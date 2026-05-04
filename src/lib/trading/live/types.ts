import type { TradeDecision } from "@alea/lib/trading/decision/types";
import type { AssetSlot } from "@alea/lib/trading/state/types";
import type { RemainingMinutes } from "@alea/lib/trading/types";
import type {
  TradableMarket,
  UpDownBook,
} from "@alea/lib/trading/vendor/types";
import type { Asset } from "@alea/types/assets";

/**
 * One log row emitted by the live runner. The CLI is the only
 * consumer that formats these for the terminal; structured tests
 * and replays consume the same shape directly.
 */
export type LiveEvent =
  | { readonly kind: "info"; readonly atMs: number; readonly message: string }
  | { readonly kind: "warn"; readonly atMs: number; readonly message: string }
  | { readonly kind: "error"; readonly atMs: number; readonly message: string }
  | {
      readonly kind: "decision";
      readonly atMs: number;
      readonly decision: TradeDecision;
    }
  | {
      readonly kind: "order-placed";
      readonly atMs: number;
      readonly asset: Asset;
      readonly slot: Extract<AssetSlot, { kind: "active" }>;
    }
  | {
      readonly kind: "fill";
      readonly atMs: number;
      readonly asset: Asset;
      readonly slot: Extract<AssetSlot, { kind: "active" }>;
    }
  | {
      readonly kind: "window-summary";
      readonly atMs: number;
      readonly windowStartMs: number;
      readonly windowEndMs: number;
      readonly body: string;
    };

/**
 * Per-window state record. The runner maintains one of these for
 * the active window plus the most recently summarized one (until its
 * wrap-up timer drops it).
 */
export type WindowRecord = {
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly perAsset: Map<Asset, AssetWindowRecord>;
  summarySent: boolean;
  cancelTimer: ReturnType<typeof setTimeout> | null;
  wrapUpTimer: ReturnType<typeof setTimeout> | null;
  /**
   * postOnly rejections observed during this window — silent at the
   * time, surfaced in the per-window Telegram summary as
   * "Cross-book rejections: N".
   */
  rejectedCount: number;
  /**
   * Orders that eventually placed successfully after one or more
   * postOnly rejections (i.e. we re-evaluated against the moved book
   * and decided we still wanted in). Subset of "all orders placed".
   */
  placedAfterRetryCount: number;
};

export type AssetWindowRecord = {
  readonly asset: Asset;
  market: TradableMarket | null;
  line: number | null;
  lineCapturedAtMs: number | null;
  lastDecisionRemaining: RemainingMinutes | null;
  slot: AssetSlot;
};

/**
 * Lookup index from vendor-side market id (Polymarket conditionId,
 * Kalshi ticker, …) to the `(windowStartMs, asset)` pair the runner
 * uses internally. Populated on every market discovery; pruned at
 * wrap-up.
 */
export type ConditionIndex = Map<
  string,
  { readonly windowStartMs: number; readonly asset: Asset }
>;

/**
 * Lifetime PnL accumulator boxed so closures can read-modify-write
 * across multiple call sites without TS narrowing it back to a
 * const-look-alike at every reference.
 */
export type LifetimePnlBox = { value: number };

/** Latest book snapshot per asset, refreshed by the book poll loop. */
export type BookCache = Map<Asset, UpDownBook>;
