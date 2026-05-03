import type { CandleSeries } from "@alea/types/candleSeries";

/**
 * The single candle series the training domain currently studies. Every
 * `training:*` command and every analysis under `src/lib/training/` should
 * pull from this constant rather than hardcoding source/product/timeframe
 * separately, so widening (or swapping) the series later is a one-line edit.
 */
export const trainingCandleSeries: CandleSeries = {
  source: "binance",
  product: "perp",
  timeframe: "5m",
};
