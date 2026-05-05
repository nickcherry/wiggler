import type { LeadingSide, RemainingMinutes } from "@alea/lib/trading/types";
import type { Asset } from "@alea/types/assets";

/**
 * Per-snapshot data computed from the live feed and the moving
 * trackers. The decision evaluator and the dry-run logger both
 * consume this same shape — there's no second layer that re-derives
 * `aligned` or `distanceBp` from raw inputs.
 *
 * As of the live distance-from-line ATR promotion, `aligned` is the
 * filter classification `|distance| >= 0.5 × atr` at the period
 * configured by `LIVE_TRADING_ATR_PERIOD` (`true` = "decisively away"),
 * NOT the previous `currentSide === ema50_regime`. `ema50` and
 * `regime` are retained for diagnostic logging only — the runner
 * still tracks EMA-50 alongside the ATR because operator-facing
 * messages and dry-run output reference it. `regime` may be `null`
 * if the EMA tracker is still warming up but the ATR tracker has
 * seeded.
 */
export type DecisionSnapshot = {
  readonly asset: Asset;
  readonly windowStartMs: number;
  readonly nowMs: number;
  readonly line: number;
  readonly currentPrice: number;
  readonly distanceBp: number;
  readonly remaining: RemainingMinutes;
  readonly ema50: number | null;
  readonly regime: LeadingSide | null;
  readonly currentSide: LeadingSide;
  readonly aligned: boolean;
};

/**
 * Per-side edge breakdown. `bid === null` means there are no resting
 * orders on that token's bid side; we cannot post a maker buy if we
 * have nothing to lean on.
 */
export type SideEdge = {
  readonly side: LeadingSide;
  readonly tokenId: string;
  readonly bid: number | null;
  readonly ourProbability: number;
  readonly edge: number | null;
};

/**
 * Reasons the evaluator declined to place a trade. Each reason is
 * emitted at most once per call so the caller can switch on it cleanly.
 */
export type DecisionSkipReason =
  | "warmup"
  | "out-of-window"
  | "too-close-to-line"
  | "no-bucket"
  | "no-bid"
  | "thin-edge"
  | "low-confidence";

export type TradeDecision =
  | {
      readonly kind: "trade";
      readonly snapshot: DecisionSnapshot;
      readonly samples: number;
      readonly chosen: SideEdge;
      readonly other: SideEdge;
    }
  | {
      readonly kind: "skip";
      readonly reason: DecisionSkipReason;
      readonly snapshot: DecisionSnapshot | null;
      readonly samples: number | null;
      readonly up: SideEdge | null;
      readonly down: SideEdge | null;
    };
