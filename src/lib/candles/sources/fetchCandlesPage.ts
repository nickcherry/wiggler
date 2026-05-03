import { fetchBinanceCandles } from "@wiggler/lib/candles/sources/binance/fetchBinanceCandles";
import { fetchBinancePerpCandles } from "@wiggler/lib/candles/sources/binance/fetchBinancePerpCandles";
import { fetchCoinbaseCandles } from "@wiggler/lib/candles/sources/coinbase/fetchCoinbaseCandles";
import { fetchCoinbasePerpCandles } from "@wiggler/lib/candles/sources/coinbase/fetchCoinbasePerpCandles";
import type { Asset } from "@wiggler/types/assets";
import type { Candle, CandleTimeframe } from "@wiggler/types/candles";
import type { Product } from "@wiggler/types/products";
import type { CandleSource } from "@wiggler/types/sources";

type FetchCandlesPageParams = {
  readonly source: CandleSource;
  readonly asset: Asset;
  readonly product: Product;
  readonly timeframe: CandleTimeframe;
  readonly start: Date;
  readonly end: Date;
};

/**
 * Coinbase Advanced Trade caps public market data at 10 requests / second
 * across the IP. With concurrency-8 the sync brushes against that limit and
 * occasionally trips a 429; we transparently honor the server's
 * `retry-after` (or fall back to a short delay) and try again. Sustained
 * 429s after this many retries indicate a real problem and we surface it.
 */
const maxRateLimitRetries = 5;
const defaultRetryAfterMs = 1_000;

/**
 * Source-and-product-agnostic single-page candle fetcher. Dispatches to the
 * appropriate exchange/market-specific fetcher and returns a uniform
 * `Candle[]` already tagged with the right `product`. No DB writes.
 *
 * Transparently retries on 429s so callers don't need to coordinate around
 * Coinbase's public rate limit.
 *
 * Note on window semantics: the underlying APIs disagree slightly on whether
 * `end` is inclusive or exclusive. For Binance spot we subtract one
 * millisecond from `end` to align with the half-open `[start, end)`
 * convention this function exposes; Coinbase and Binance Vision archives
 * already filter on a strict half-open window.
 */
export async function fetchCandlesPage(
  params: FetchCandlesPageParams,
): Promise<readonly Candle[]> {
  let attempt = 0;
  while (true) {
    try {
      return await fetchCandlesPageOnce(params);
    } catch (err) {
      if (!isRateLimited(err) || attempt >= maxRateLimitRetries) {
        throw err;
      }
      const waitMs = retryAfterMs(err);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      attempt++;
    }
  }
}

async function fetchCandlesPageOnce({
  source,
  asset,
  product,
  timeframe,
  start,
  end,
}: FetchCandlesPageParams): Promise<readonly Candle[]> {
  switch (source) {
    case "coinbase":
      switch (product) {
        case "spot":
          return fetchCoinbaseCandles({ asset, timeframe, start, end });
        case "perp":
          return fetchCoinbasePerpCandles({ asset, timeframe, start, end });
      }
      break;
    case "binance":
      switch (product) {
        case "spot":
          return fetchBinanceCandles({
            asset,
            timeframe,
            start,
            end: new Date(end.getTime() - 1),
          });
        case "perp":
          return fetchBinancePerpCandles({ asset, timeframe, start, end });
      }
      break;
  }
}

function isRateLimited(err: unknown): err is { status: number } {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    err.status === 429
  );
}

function retryAfterMs(err: unknown): number {
  if (typeof err !== "object" || err === null) {
    return defaultRetryAfterMs;
  }
  const seconds = (err as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
    return Math.ceil(seconds * 1000);
  }
  return defaultRetryAfterMs;
}
