import { coinbaseGranularity } from "@wiggler/lib/candles/sources/coinbase/coinbaseGranularity";
import { coinbaseCandlesResponseSchema } from "@wiggler/lib/candles/sources/coinbase/schemas";
import type { Asset } from "@wiggler/types/assets";
import type { Candle, CandleTimeframe } from "@wiggler/types/candles";
import type { Product } from "@wiggler/types/products";

const baseUrl = "https://api.coinbase.com";

type FetchCoinbaseAdvancedTradeCandlesParams = {
  readonly productId: string;
  readonly product: Product;
  readonly asset: Asset;
  readonly timeframe: CandleTimeframe;
  readonly start: Date;
  readonly end: Date;
};

/**
 * Fetches a single page of validated candles from a Coinbase Advanced Trade
 * public market data product. Pure — no DB writes. Returns candles sorted
 * ascending by timestamp regardless of API order.
 *
 * The same endpoint serves spot (`BTC-USD`) and Coinbase International perps
 * (`BTC-PERP-INTX`); callers pass the resolved `productId` + `product` label
 * so the resulting `Candle` rows are tagged with the right market.
 */
export async function fetchCoinbaseAdvancedTradeCandles({
  productId,
  product,
  asset,
  timeframe,
  start,
  end,
}: FetchCoinbaseAdvancedTradeCandlesParams): Promise<readonly Candle[]> {
  const granularity = coinbaseGranularity({ timeframe });
  const startSec = Math.floor(start.getTime() / 1000);
  const endSec = Math.floor(end.getTime() / 1000);

  const url = `${baseUrl}/api/v3/brokerage/market/products/${productId}/candles?start=${startSec}&end=${endSec}&granularity=${granularity}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "wiggler/1.0" },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new CoinbaseFetchError({
      message: `Coinbase ${productId} ${granularity} ${startSec}-${endSec} failed: ${response.status} ${body}`,
      status: response.status,
      retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
    });
  }

  const parsed = coinbaseCandlesResponseSchema.parse(await response.json());

  const candles: Candle[] = parsed.candles.map((raw) => ({
    source: "coinbase",
    asset,
    product,
    timeframe,
    timestamp: new Date(Number(raw.start) * 1000),
    open: Number(raw.open),
    high: Number(raw.high),
    low: Number(raw.low),
    close: Number(raw.close),
    volume: Number(raw.volume),
  }));

  candles.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  return candles;
}

export class CoinbaseFetchError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;

  constructor({
    message,
    status,
    retryAfterSeconds,
  }: {
    readonly message: string;
    readonly status: number;
    readonly retryAfterSeconds: number | undefined;
  }) {
    super(message);
    this.name = "CoinbaseFetchError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
