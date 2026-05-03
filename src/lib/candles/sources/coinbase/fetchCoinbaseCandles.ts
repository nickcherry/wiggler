import { coinbaseProductId } from "@alea/lib/candles/sources/coinbase/coinbaseProductId";
import { fetchCoinbaseAdvancedTradeCandles } from "@alea/lib/candles/sources/coinbase/fetchCoinbaseAdvancedTradeCandles";
import type { Asset } from "@alea/types/assets";
import type { Candle, CandleTimeframe } from "@alea/types/candles";

type FetchCoinbaseCandlesParams = {
  readonly asset: Asset;
  readonly timeframe: CandleTimeframe;
  readonly start: Date;
  readonly end: Date;
};

/**
 * Fetches one page of Coinbase spot candles (`{ASSET}-USD`) for the given
 * window. Thin wrapper over the shared Advanced Trade fetcher that resolves
 * the spot product id and tags the result rows with `product: "spot"`.
 */
export async function fetchCoinbaseCandles({
  asset,
  timeframe,
  start,
  end,
}: FetchCoinbaseCandlesParams): Promise<readonly Candle[]> {
  return fetchCoinbaseAdvancedTradeCandles({
    productId: coinbaseProductId({ asset }),
    product: "spot",
    asset,
    timeframe,
    start,
    end,
  });
}
