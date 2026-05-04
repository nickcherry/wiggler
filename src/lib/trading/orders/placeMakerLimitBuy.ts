import { STAKE_USD } from "@alea/constants/trading";
import type { PlacedOrder } from "@alea/lib/trading/orders/types";
import type { LeadingSide } from "@alea/lib/trading/types";
import type { ClobClient } from "@polymarket/clob-client";
import { OrderType, Side } from "@polymarket/clob-client";
import { z } from "zod";

/**
 * Thrown when Polymarket rejects a `postOnly: true` order because it
 * would cross the spread (= would have been filled as taker). Callers
 * treat this as the *expected* failure mode — the price moved between
 * book read and post — and re-evaluate against the fresh state. NOT
 * surfaced over Telegram on its own; counted in the per-window
 * summary instead.
 */
export class PostOnlyRejectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostOnlyRejectionError";
  }
}

/**
 * Maker-only limit BUY of a YES outcome token. Posts a GTC limit at
 * `limitPrice` with `postOnly: true`, which makes the venue REJECT
 * the order if it would cross the spread (= become a taker). This is
 * the only way orders are placed in the live trader; we never want
 * a taker fill on these markets because their taker fee can be up to
 * ~7% on a $20 stake.
 *
 * Size is computed as `STAKE_USD / limitPrice` rounded down to the
 * venue's `orderMinSize` quantum: shipping a non-integer share count
 * is fine for cents-priced tokens but the SDK enforces a minimum so
 * we round down to keep the cost ≤ STAKE_USD.
 *
 * Returns the canonical `PlacedOrder` view of the freshly-resting
 * order; the caller stores it in the per-asset slot and consumes
 * fill events from the user WS channel to advance state.
 */
export async function placeMakerLimitBuy({
  client,
  side,
  tokenId,
  limitPrice,
  negRisk,
  feeRateBps,
}: {
  readonly client: ClobClient;
  readonly side: LeadingSide;
  readonly tokenId: string;
  readonly limitPrice: number;
  readonly negRisk: boolean;
  readonly feeRateBps: number;
}): Promise<PlacedOrder> {
  if (!Number.isFinite(limitPrice) || limitPrice <= 0 || limitPrice >= 1) {
    throw new Error(
      `placeMakerLimitBuy: limitPrice must be in (0, 1), got ${limitPrice}`,
    );
  }
  // Polymarket prices to 2 decimals (orderPriceMinTickSize: 0.01) — we
  // round to that grid to avoid the SDK rejecting our limit price.
  const tickedPrice = Math.round(limitPrice * 100) / 100;
  if (tickedPrice <= 0 || tickedPrice >= 1) {
    throw new Error(
      `placeMakerLimitBuy: ticked price ${tickedPrice} fell outside (0, 1)`,
    );
  }
  // Round shares to two decimals down. Polymarket allows fractional
  // shares; rounding *down* keeps total cost ≤ STAKE_USD.
  const rawShares = STAKE_USD / tickedPrice;
  const shares = Math.floor(rawShares * 100) / 100;
  if (shares <= 0) {
    throw new Error(
      `placeMakerLimitBuy: computed shares ≤ 0 (price=${tickedPrice}, stake=${STAKE_USD})`,
    );
  }

  const signed = await client.createOrder(
    {
      tokenID: tokenId,
      price: tickedPrice,
      size: shares,
      side: Side.BUY,
      feeRateBps,
    },
    { negRisk },
  );

  const response = await client.postOrder(
    signed,
    OrderType.GTC,
    /* deferExec */ false,
    /* postOnly */ true,
  );

  const parsed = postOrderResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new Error(
      `placeMakerLimitBuy: unexpected postOrder response shape: ${JSON.stringify(response)}`,
    );
  }
  if (parsed.data.success === false) {
    const errorMsg = parsed.data.errorMsg ?? "unknown error";
    if (looksLikePostOnlyRejection({ message: errorMsg })) {
      throw new PostOnlyRejectionError(errorMsg);
    }
    throw new Error(`placeMakerLimitBuy: postOrder rejected: ${errorMsg}`);
  }
  if (
    typeof parsed.data.orderID !== "string" ||
    parsed.data.orderID.length === 0
  ) {
    throw new Error(
      `placeMakerLimitBuy: postOrder accepted but returned no orderID: ${JSON.stringify(response)}`,
    );
  }

  return {
    orderId: parsed.data.orderID,
    side,
    tokenId,
    limitPrice: tickedPrice,
    stakeUsd: shares * tickedPrice,
    sharesIfFilled: shares,
    feeRateBps,
    placedAtMs: Date.now(),
  };
}

/**
 * Crude phrase match against the venue's `errorMsg`. Polymarket has
 * not stabilized a machine-readable error code for postOnly rejections,
 * so we look for any of the obvious phrases. False negatives surface
 * as a generic error — the worst case is one extra Telegram alert,
 * not a wrong trading decision.
 */
function looksLikePostOnlyRejection({
  message,
}: {
  readonly message: string;
}): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("post only") ||
    lower.includes("postonly") ||
    lower.includes("would match") ||
    lower.includes("would cross") ||
    lower.includes("would taker") ||
    lower.includes("would fill")
  );
}

const postOrderResponseSchema = z
  .object({
    success: z.boolean().optional(),
    errorMsg: z.string().optional(),
    orderID: z.string().optional(),
  })
  .passthrough();
