import type { UpDownMarket } from "@alea/lib/polymarket/markets/types";
import type { LeadingSide } from "@alea/lib/trading/types";

/**
 * Per-asset slot state for the live runner. The system invariant from
 * the chunk-2 spec — "max one order OR position per asset at any
 * time, not one of each, not more" — is enforced at the call site
 * (the runner refuses to place a new order unless the slot is
 * `empty`); this type is the underlying state.
 *
 * Stages within a single 5m window, reset to `empty` at the next
 * window's open:
 *
 *   empty
 *     │  evaluator picks a TAKE side and the runner places one
 *     │  maker limit BUY at the venue
 *     ▼
 *   active                    ◀── unified "order resting and/or
 *                                filled" state. `orderId` is non-null
 *                                while the resting portion still
 *                                lives; `sharesFilled` accumulates as
 *                                fill events arrive over WS. Partial
 *                                fills stay here (orderId stays set)
 *                                until cancellation or further fills.
 *     │  T + 5m wrap-up: cancel residual order, settle whatever
 *     │  filled, and roll into one of the two terminal states below.
 *     ▼
 *   noFill        ◀── no shares ever filled (clean cancel).
 *   settled       ◀── at least one fill landed; net PnL is realized.
 */
export type AssetSlot =
  | { readonly kind: "empty" }
  | {
      readonly kind: "active";
      readonly market: UpDownMarket;
      readonly side: LeadingSide;
      readonly tokenId: string;
      /**
       * `null` once the resting portion of the order has been
       * cancelled or fully filled. Tracked so the wrap-up cancel call
       * is a no-op when there is nothing left to cancel.
       */
      readonly orderId: string | null;
      readonly limitPrice: number;
      readonly sharesFilled: number;
      readonly costUsd: number;
      /** Share-weighted average maker fee rate across observed fills. */
      readonly feeRateBpsAvg: number;
    }
  | {
      readonly kind: "noFill";
      readonly market: UpDownMarket;
      readonly side: LeadingSide;
      readonly limitPrice: number;
    }
  | {
      readonly kind: "settled";
      readonly market: UpDownMarket;
      readonly side: LeadingSide;
      readonly fillPriceAvg: number;
      readonly sharesFilled: number;
      readonly costUsd: number;
      readonly feesUsd: number;
      readonly won: boolean;
      readonly grossPnlUsd: number;
      readonly netPnlUsd: number;
    };
