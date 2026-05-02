import { z } from "zod";

/**
 * Raw Binance kline arrives as a positional array. We validate the shape and
 * the slots we actually use.
 *
 * Index reference (per Binance docs):
 *   0 open_time (ms), 1 open, 2 high, 3 low, 4 close, 5 volume,
 *   6 close_time (ms), 7 quote_asset_volume, 8 trade_count,
 *   9 taker_buy_base_volume, 10 taker_buy_quote_volume, 11 ignore
 */
export const binanceRawKlineSchema = z.tuple([
  z.number(), // open_time ms
  z.string(), // open
  z.string(), // high
  z.string(), // low
  z.string(), // close
  z.string(), // volume
  z.number(), // close_time ms
  z.string(), // quote_asset_volume
  z.number(), // trade_count
  z.string(), // taker_buy_base_volume
  z.string(), // taker_buy_quote_volume
  z.string(), // ignore
]);

export const binanceKlinesResponseSchema = z.array(binanceRawKlineSchema);

export type BinanceRawKline = z.infer<typeof binanceRawKlineSchema>;
