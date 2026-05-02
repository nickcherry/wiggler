import { z } from "zod";

/**
 * Raw candle row returned by Coinbase Advanced Trade public market data
 * endpoint. All numeric fields arrive as strings; we normalize at the
 * boundary.
 */
export const coinbaseRawCandleSchema = z.object({
  start: z.string(),
  low: z.string(),
  high: z.string(),
  open: z.string(),
  close: z.string(),
  volume: z.string(),
});

export const coinbaseCandlesResponseSchema = z.object({
  candles: z.array(coinbaseRawCandleSchema),
});

export type CoinbaseRawCandle = z.infer<typeof coinbaseRawCandleSchema>;
