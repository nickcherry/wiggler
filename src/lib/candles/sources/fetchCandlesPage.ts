import { fetchBinanceCandles } from "@wiggler/lib/candles/sources/binance/fetchBinanceCandles";
import { fetchCoinbaseCandles } from "@wiggler/lib/candles/sources/coinbase/fetchCoinbaseCandles";
import type { Asset } from "@wiggler/types/assets";
import type { Candle, CandleTimeframe } from "@wiggler/types/candles";
import type { CandleSource } from "@wiggler/types/sources";

type FetchCandlesPageParams = {
  readonly source: CandleSource;
  readonly asset: Asset;
  readonly timeframe: CandleTimeframe;
  readonly start: Date;
  readonly end: Date;
};

/**
 * Source-agnostic single-page candle fetcher. Dispatches to the appropriate
 * exchange-specific fetcher and returns a uniform `Candle[]`. No DB writes.
 *
 * Note on window semantics: the underlying APIs disagree slightly on whether
 * `end` is inclusive or exclusive. For Binance we subtract one millisecond
 * from `end` to align with the half-open `[start, end)` convention this
 * function exposes; Coinbase already treats the bound that way.
 */
export async function fetchCandlesPage({
  source,
  asset,
  timeframe,
  start,
  end,
}: FetchCandlesPageParams): Promise<readonly Candle[]> {
  switch (source) {
    case "coinbase":
      return fetchCoinbaseCandles({ asset, timeframe, start, end });
    case "binance":
      return fetchBinanceCandles({
        asset,
        timeframe,
        start,
        end: new Date(end.getTime() - 1),
      });
  }
}
