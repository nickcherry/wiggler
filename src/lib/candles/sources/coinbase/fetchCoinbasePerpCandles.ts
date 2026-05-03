import { coinbasePerpProductId } from "@wiggler/lib/candles/sources/coinbase/coinbasePerpProductId";
import { fetchCoinbaseAdvancedTradeCandles } from "@wiggler/lib/candles/sources/coinbase/fetchCoinbaseAdvancedTradeCandles";
import type { Asset } from "@wiggler/types/assets";
import type { Candle, CandleTimeframe } from "@wiggler/types/candles";

type FetchCoinbasePerpCandlesParams = {
  readonly asset: Asset;
  readonly timeframe: CandleTimeframe;
  readonly start: Date;
  readonly end: Date;
};

/**
 * Fetches one page of Coinbase International perpetual swap candles
 * (`{ASSET}-PERP-INTX`) for the given window. Thin wrapper over the shared
 * Advanced Trade fetcher that resolves the perp product id and tags the
 * result rows with `product: "perp"`.
 */
export async function fetchCoinbasePerpCandles({
  asset,
  timeframe,
  start,
  end,
}: FetchCoinbasePerpCandlesParams): Promise<readonly Candle[]> {
  return fetchCoinbaseAdvancedTradeCandles({
    productId: coinbasePerpProductId({ asset }),
    product: "perp",
    asset,
    timeframe,
    start,
    end,
  });
}
