import { candlesPerFetchPage } from "@wiggler/constants/candles";
import { binanceInterval } from "@wiggler/lib/candles/sources/binance/binanceInterval";
import { binanceSymbol } from "@wiggler/lib/candles/sources/binance/binanceSymbol";
import { binanceKlinesResponseSchema } from "@wiggler/lib/candles/sources/binance/schemas";
import type { Asset } from "@wiggler/types/assets";
import type { Candle, CandleTimeframe } from "@wiggler/types/candles";

const baseUrl = "https://data-api.binance.vision";

type FetchBinanceCandlesParams = {
  readonly asset: Asset;
  readonly timeframe: CandleTimeframe;
  readonly start: Date;
  readonly end: Date;
  readonly limit?: number;
};

/**
 * Fetches a single page of validated klines from Binance public market data.
 * Pure — no DB writes. Klines arrive ascending by open time; we preserve
 * that order.
 *
 * Binance treats `endTime` as inclusive. Callers wanting a half-open
 * `[start, end)` window should subtract one millisecond from `end`.
 */
export async function fetchBinanceCandles({
  asset,
  timeframe,
  start,
  end,
  limit = candlesPerFetchPage,
}: FetchBinanceCandlesParams): Promise<readonly Candle[]> {
  const symbol = binanceSymbol({ asset });
  const interval = binanceInterval({ timeframe });
  const startMs = start.getTime();
  const endMs = end.getTime();

  const url =
    `${baseUrl}/api/v3/klines?symbol=${symbol}&interval=${interval}` +
    `&startTime=${startMs}&endTime=${endMs}&limit=${limit}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "wiggler/1.0" },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new BinanceFetchError({
      message: `Binance ${symbol} ${interval} ${startMs}-${endMs} failed: ${response.status} ${body}`,
      status: response.status,
      retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
    });
  }

  const klines = binanceKlinesResponseSchema.parse(await response.json());

  return klines.map((k) => ({
    source: "binance" as const,
    asset,
    product: "spot" as const,
    timeframe,
    timestamp: new Date(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

export class BinanceFetchError extends Error {
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
    this.name = "BinanceFetchError";
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
