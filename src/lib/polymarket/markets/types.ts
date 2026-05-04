import { assetSchema } from "@alea/types/assets";
import { z } from "zod";

/**
 * Identity of one Polymarket "up/down at <ts>" 5-minute market — exactly
 * the data we need to read its book and (in chunk 2) submit orders
 * against it. The `windowStartUnixSeconds` mirrors the slug encoding
 * Polymarket uses so a glance at any log line ties directly back to
 * the URL on polymarket.com.
 */
export const upDownMarketSchema = z.object({
  asset: assetSchema,
  windowStartUnixSeconds: z.int().positive(),
  windowStartMs: z.int().positive(),
  windowEndMs: z.int().positive(),
  slug: z.string(),
  conditionId: z.string(),
  /** Token id whose YES pays out 1 USDC if the price goes UP. */
  upYesTokenId: z.string(),
  /** Token id whose YES pays out 1 USDC if the price goes DOWN. */
  downYesTokenId: z.string(),
  /** Polymarket's neg-risk flag. Required for order construction later. */
  negRisk: z.boolean(),
  /**
   * `acceptingOrders` from the gamma response. `false` here means the
   * book is read-only (book is closed or settling); we still expose
   * the market so the caller can log or wait, but we never try to post.
   */
  acceptingOrders: z.boolean(),
});

export type UpDownMarket = z.infer<typeof upDownMarketSchema>;

/**
 * Top-of-book snapshot for one outcome token. `null` for either side
 * means "no resting orders on that side" — quite common in the first
 * minutes of a fresh market.
 */
export type TopOfBook = {
  readonly tokenId: string;
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly fetchedAtMs: number;
};

/**
 * Paired book snapshot for both YES tokens of one up/down market.
 */
export type UpDownBookSnapshot = {
  readonly market: UpDownMarket;
  readonly up: TopOfBook;
  readonly down: TopOfBook;
};
