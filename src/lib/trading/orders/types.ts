import type { LeadingSide } from "@alea/lib/trading/types";

/**
 * Result of a successful maker-only limit-buy order placement. Captures
 * everything the runner needs to track the order's lifecycle without
 * round-tripping back to Polymarket: the on-venue order id, the price
 * we paid, the dollar cost, the share count we'd own if fully filled,
 * the side we bet on, and the fee rate the venue accepted us at.
 */
export type PlacedOrder = {
  readonly orderId: string;
  readonly side: LeadingSide;
  readonly tokenId: string;
  readonly limitPrice: number;
  readonly stakeUsd: number;
  readonly sharesIfFilled: number;
  readonly feeRateBps: number;
  readonly placedAtMs: number;
};
