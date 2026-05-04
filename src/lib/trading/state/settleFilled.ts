import { WINNING_YES_PAYOUT_USD } from "@alea/constants/trading";
import type { AssetSlot } from "@alea/lib/trading/state/types";
import type { LeadingSide } from "@alea/lib/trading/types";

/**
 * Resolves an `active` slot at window-end into a terminal state using
 * the underlying's final price vs the window's line. This is the
 * chunk-2 "PnL with real fees" computation; the runner consumes the
 * resulting `netPnlUsd` for the Telegram summary.
 *
 * Settlement convention:
 *
 *   - Winning side: `up` if `finalPrice ≥ line`, else `down`. Same tie-
 *     break the training and decision pipelines use.
 *   - Gross win:  `sharesFilled × $1 − costUsd`.
 *   - Gross loss: `−costUsd`.
 *   - Fees:       exact fill fees accumulated at the vendor boundary.
 *   - Net PnL:    `gross − fee`.
 *
 * If `active.sharesFilled === 0` (we placed an order, nothing filled)
 * we produce the `noFill` terminal state instead — there's no PnL to
 * compute, and the summary phrase is "didn't fill" rather than
 * "won/lost".
 *
 * Note we settle off the Binance perp final close, not the Chainlink
 * oracle Polymarket actually uses. The two effectively never disagree
 * directionally, and we accept the small chance of a one-window
 * mismatch in exchange for lower latency on the way in. The actual
 * USDC balance on the wallet is the on-chain source of truth and will
 * always reflect the venue's settlement, not ours.
 */
export function settleFilled({
  active,
  finalPrice,
  line,
}: {
  readonly active: Extract<AssetSlot, { kind: "active" }>;
  readonly finalPrice: number;
  readonly line: number;
}):
  | Extract<AssetSlot, { kind: "settled" }>
  | Extract<AssetSlot, { kind: "noFill" }> {
  if (active.sharesFilled <= 0) {
    return {
      kind: "noFill",
      market: active.market,
      side: active.side,
      limitPrice: active.limitPrice,
    };
  }
  const winningSide: LeadingSide = finalPrice >= line ? "up" : "down";
  const won = active.side === winningSide;
  const grossPayout = won ? active.sharesFilled * WINNING_YES_PAYOUT_USD : 0;
  const grossPnl = grossPayout - active.costUsd;
  const feesUsd = active.feesUsd;
  const netPnl = grossPnl - feesUsd;
  const fillPriceAvg = active.costUsd / active.sharesFilled;
  return {
    kind: "settled",
    market: active.market,
    side: active.side,
    fillPriceAvg,
    sharesFilled: active.sharesFilled,
    costUsd: active.costUsd,
    feesUsd,
    won,
    grossPnlUsd: grossPnl,
    netPnlUsd: netPnl,
  };
}
