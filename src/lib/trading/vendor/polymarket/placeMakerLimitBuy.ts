import type { LeadingSide } from "@alea/lib/trading/types";
import type { PolymarketOrderConstraints } from "@alea/lib/trading/vendor/polymarket/marketConstraints";
import {
  type PlacedOrder,
  PostOnlyRejectionError,
  type TradableMarket,
} from "@alea/lib/trading/vendor/types";
import { type ClobClient, OrderType, Side } from "@polymarket/clob-client-v2";
import { z } from "zod";

const GTD_MIN_VALIDITY_MS = 60_000;

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
 * ≤ stake. Limit price is rounded down to the market's venue-provided
 * tick size, and the placed order is GTD so it expires before the
 * five-minute market closes even if our cancel call fails.
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
  expireBeforeMs,
  constraints,
}: {
  readonly client: ClobClient;
  readonly market: TradableMarket;
  readonly side: LeadingSide;
  readonly limitPrice: number;
  readonly stakeUsd: number;
  readonly expireBeforeMs: number;
  readonly constraints: PolymarketOrderConstraints;
}): Promise<PlacedOrder> {
  if (!Number.isFinite(limitPrice) || limitPrice <= 0 || limitPrice >= 1) {
    throw new Error(
      `placePolymarketMakerLimitBuy: limitPrice must be in (0, 1), got ${limitPrice}`,
    );
  }
  const nowMs = Date.now();
  const minimumValidityMs = Math.max(
    GTD_MIN_VALIDITY_MS,
    constraints.minimumOrderAgeSeconds * 1000,
  );
  if (nowMs + minimumValidityMs >= expireBeforeMs) {
    throw new Error(
      `placePolymarketMakerLimitBuy: not enough time before GTD expiry to satisfy minimum validity (${minimumValidityMs}ms)`,
    );
  }
  const tickedPrice = floorToTick({
    price: limitPrice,
    tickSize: constraints.priceTickSize,
  });
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
  if (shares < constraints.minOrderSize) {
    throw new Error(
      `placePolymarketMakerLimitBuy: computed shares ${shares} below venue minimum ${constraints.minOrderSize}`,
    );
  }
  const tokenId = side === "up" ? market.upRef : market.downRef;
  const expiration = Math.floor(expireBeforeMs / 1000);

  const signed = await client.createOrder(
    {
      tokenID: tokenId,
      price: tickedPrice,
      size: shares,
      side: Side.BUY,
      expiration,
    },
    { negRisk: constraints.negRisk, tickSize: constraints.tickSize },
  );

  const response = await client.postOrder(
    signed,
    OrderType.GTD,
    /* postOnly */ true,
    /* deferExec */ false,
  );

  const parsed = postOrderResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new Error(
      `placePolymarketMakerLimitBuy: unexpected postOrder response shape: ${JSON.stringify(response)}`,
    );
  }
  const responseError =
    nonEmptyString(parsed.data.errorMsg) ?? nonEmptyString(parsed.data.error);
  if (parsed.data.success === false || responseError !== undefined) {
    const errorMsg = responseError ?? "unknown error";
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
    orderType: "GTD",
    expiresAtMs: expireBeforeMs,
    placedAtMs: nowMs,
  };
}

function nonEmptyString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function floorToTick({
  price,
  tickSize,
}: {
  readonly price: number;
  readonly tickSize: number;
}): number {
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    throw new Error(`invalid tick size ${tickSize}`);
  }
  const decimals = decimalPlaces({ value: tickSize });
  return Number(
    (Math.floor((price + 1e-12) / tickSize) * tickSize).toFixed(decimals),
  );
}

function decimalPlaces({ value }: { readonly value: number }): number {
  const text = value.toString();
  const decimal = text.indexOf(".");
  return decimal === -1 ? 0 : text.length - decimal - 1;
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
    error: z.string().optional(),
    status: z.union([z.number(), z.string()]).optional(),
    orderID: z.string().optional(),
  })
  .passthrough();
