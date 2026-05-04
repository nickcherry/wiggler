import type { LeadingSide } from "@alea/lib/trading/types";
import {
  type PlacedOrder,
  PostOnlyRejectionError,
  type TradableMarket,
} from "@alea/lib/trading/vendor/types";
import { type ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { z } from "zod";

/**
 * Maker-only limit BUY of a YES outcome token on Polymarket. Posts
 * `postOnly: true`, which makes the venue REJECT the order when it
 * would cross the spread (= would have been filled as taker). This
 * is the only way orders are placed in the live trader; a taker fill
 * on these markets carries up to ~7% in fees that would erase any
 * edge.
 *
 * Order size is computed as `stakeUsd / limitPrice`, rounded down to
 * Polymarket's 2-decimal share quantum so the resulting cost stays
 * ≤ stake. Limit price is rounded to the venue's 0.01 tick.
 *
 * Translates Polymarket's free-form rejection error into the typed
 * `PostOnlyRejectionError` so the runner's retry loop can distinguish
 * cross-the-book rejections from generic failures.
 */
export async function placePolymarketMakerLimitBuy({
  client,
  market,
  side,
  limitPrice,
  stakeUsd,
  negRisk,
}: {
  readonly client: ClobClient;
  readonly market: TradableMarket;
  readonly side: LeadingSide;
  readonly limitPrice: number;
  readonly stakeUsd: number;
  readonly negRisk: boolean;
}): Promise<PlacedOrder> {
  if (!Number.isFinite(limitPrice) || limitPrice <= 0 || limitPrice >= 1) {
    throw new Error(
      `placePolymarketMakerLimitBuy: limitPrice must be in (0, 1), got ${limitPrice}`,
    );
  }
  const tickedPrice = Math.round(limitPrice * 100) / 100;
  if (tickedPrice <= 0 || tickedPrice >= 1) {
    throw new Error(
      `placePolymarketMakerLimitBuy: ticked price ${tickedPrice} fell outside (0, 1)`,
    );
  }
  const rawShares = stakeUsd / tickedPrice;
  const shares = Math.floor(rawShares * 100) / 100;
  if (shares <= 0) {
    throw new Error(
      `placePolymarketMakerLimitBuy: computed shares ≤ 0 (price=${tickedPrice}, stake=${stakeUsd})`,
    );
  }
  const tokenId = side === "up" ? market.upRef : market.downRef;

  const signed = await client.createOrder(
    {
      tokenID: tokenId,
      price: tickedPrice,
      size: shares,
      side: Side.BUY,
      feeRateBps: 0,
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
      `placePolymarketMakerLimitBuy: unexpected postOrder response shape: ${JSON.stringify(response)}`,
    );
  }
  if (parsed.data.success === false) {
    const errorMsg = parsed.data.errorMsg ?? "unknown error";
    if (looksLikePostOnlyRejection({ message: errorMsg })) {
      throw new PostOnlyRejectionError(errorMsg);
    }
    throw new Error(
      `placePolymarketMakerLimitBuy: postOrder rejected: ${errorMsg}`,
    );
  }
  if (
    typeof parsed.data.orderID !== "string" ||
    parsed.data.orderID.length === 0
  ) {
    throw new Error(
      `placePolymarketMakerLimitBuy: postOrder accepted but returned no orderID: ${JSON.stringify(response)}`,
    );
  }

  return {
    orderId: parsed.data.orderID,
    side,
    outcomeRef: tokenId,
    limitPrice: tickedPrice,
    sharesIfFilled: shares,
    feeRateBps: 0,
    placedAtMs: Date.now(),
  };
}

/**
 * Crude phrase match against the venue's `errorMsg`. Polymarket has
 * no machine-readable code for postOnly rejections, so we look for
 * the obvious phrases. False negatives surface as a generic error —
 * worst case is one extra Telegram alert, never a wrong trade.
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
