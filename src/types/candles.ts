import { candleTimeframeValues } from "@alea/constants/candles";
import { productSchema } from "@alea/types/products";
import { candleSourceSchema } from "@alea/types/sources";
import { z } from "zod";

/**
 * Boundary schema for candle timeframe inputs.
 */
export const candleTimeframeSchema = z
  .enum(candleTimeframeValues)
  .describe("Candle timeframe to operate on.");

export type CandleTimeframe = z.infer<typeof candleTimeframeSchema>;

/**
 * Canonical, validated candle row produced by exchange fetchers and consumed
 * by the persistence layer. Uses `timestamp` (start of bar, UTC) as the
 * temporal key rather than a separate ms field; the DB stores it as
 * `timestamptz`.
 */
export const candleSchema = z.object({
  source: candleSourceSchema,
  asset: z.string(),
  product: productSchema,
  timeframe: candleTimeframeSchema,
  timestamp: z.date(),
  open: z.number().finite(),
  high: z.number().finite(),
  low: z.number().finite(),
  close: z.number().finite(),
  volume: z.number().finite(),
});

export type Candle = z.infer<typeof candleSchema>;
