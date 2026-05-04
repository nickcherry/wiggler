import { polymarket } from "@alea/constants/polymarket";
import type { MarketOutcome, TradableMarket } from "@alea/lib/trading/vendor/types";
import { z } from "zod";

export async function resolvePolymarketMarketOutcome({
  market,
  signal,
}: {
  readonly market: TradableMarket;
  readonly signal?: AbortSignal;
}): Promise<MarketOutcome> {
  const response = await fetch(
    `${polymarket.clobApiUrl}/markets/${market.vendorRef}`,
    { headers: { "User-Agent": "alea/1.0" }, signal },
  );
  if (!response.ok) {
    return {
      status: "pending",
      market,
      checkedAtMs: Date.now(),
      reason: `CLOB /markets/${market.vendorRef} returned ${response.status}`,
    };
  }
  const parsed = marketSchema.safeParse(await response.json());
  if (!parsed.success) {
    return {
      status: "pending",
      market,
      checkedAtMs: Date.now(),
      reason: "unexpected market response shape",
    };
  }
  const winner = parsed.data.tokens.find((token) => token.winner === true);
  const tokenId = winner?.token_id;
  if (tokenId === market.upRef) {
    return {
      status: "resolved",
      market,
      winningSide: "up",
      winningOutcomeRef: market.upRef,
      resolvedAtMs: Date.now(),
    };
  }
  if (tokenId === market.downRef) {
    return {
      status: "resolved",
      market,
      winningSide: "down",
      winningOutcomeRef: market.downRef,
      resolvedAtMs: Date.now(),
    };
  }
  return {
    status: "pending",
    market,
    checkedAtMs: Date.now(),
    reason:
      parsed.data.closed === true
        ? "market closed but no winning up/down token was reported"
        : "market not closed",
  };
}

const marketSchema = z
  .object({
    closed: z.boolean().optional(),
    tokens: z
      .array(
        z
          .object({
            token_id: z.string(),
            winner: z.boolean().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
