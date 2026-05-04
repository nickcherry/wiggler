import { binancePerpSymbol } from "@alea/lib/candles/sources/binance/binancePerpSymbol";
import type { ClosedFiveMinuteBar } from "@alea/lib/livePrices/types";
import type { Asset } from "@alea/types/assets";
import { z } from "zod";

const fapiBaseUrl = "https://fapi.binance.com";
const fiveMinuteMs = 5 * 60 * 1000;

/**
 * Live-trading boot helper. Pulls the most recent CLOSED 5m bars off the
 * Binance USDT-M futures REST endpoint so the EMA-50 tracker has a hot
 * seed at startup, instead of waiting ~4 hours of streaming closes to
 * accumulate one organically.
 *
 * Distinct from `src/lib/candles/sources/binance/fetchBinancePerpCandles.ts`,
 * which goes through the Binance Vision S3 archives. Vision is the right
 * choice for historical backfills (no rate limits, no geo-block, full
 * UTC-day coverage) but doesn't publish today's bars until the day
 * closes — useless for boot hydration.
 *
 * Geo: `fapi.binance.com` is unreachable from the United States. The bot
 * is deployed in Spain and runs locally over a non-US VPN, so this is
 * acceptable. If we ever need a US-friendly path the alternative is
 * Coinbase or a paid proxy.
 *
 * Returns at most `count` bars in chronological order. Filters out the
 * currently-open bar — the in-progress 5m candle never counts toward
 * EMA-50 in our model.
 */
export async function fetchRecentFiveMinuteBars({
  asset,
  count,
  signal,
}: {
  readonly asset: Asset;
  readonly count: number;
  readonly signal?: AbortSignal;
}): Promise<readonly ClosedFiveMinuteBar[]> {
  if (count <= 0) {
    return [];
  }
  // We over-fetch by one and drop any in-progress bar so the caller
  // always receives `count` closed bars even if the request lands
  // mid-window.
  const symbol = binancePerpSymbol({ asset });
  const limit = Math.min(count + 1, 1500);
  const url = `${fapiBaseUrl}/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=${limit}`;

  const response = await fetch(url, {
    headers: { "User-Agent": "alea/1.0" },
    signal,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Binance fapi /klines for ${symbol} failed: ${response.status} ${body}`,
    );
  }
  const raw = await response.json();
  const parsed = klineRowsSchema.parse(raw);
  const nowMs = Date.now();
  const out: ClosedFiveMinuteBar[] = [];
  for (const row of parsed) {
    const openTimeMs = row[0];
    const closeTimeMs = openTimeMs + fiveMinuteMs;
    if (closeTimeMs > nowMs) {
      // Skip the in-progress bar.
      continue;
    }
    out.push({
      asset,
      openTimeMs,
      closeTimeMs,
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
    });
  }
  // Defensive trim: even though we asked for `count + 1`, Binance has
  // historically returned `limit` exactly, so the trim only kicks in
  // when our skip-the-open-bar branch didn't fire.
  return out.slice(-count);
}

/**
 * Binance returns klines as positional arrays:
 * `[openTime, open, high, low, close, volume, closeTime, ...]`. We
 * validate the prefix we use; Zod tolerates the extra trailing fields.
 */
const klineRowsSchema = z.array(
  z
    .tuple([
      z.number(),
      z.string(),
      z.string(),
      z.string(),
      z.string(),
      z.string(),
      z.number(),
    ])
    .rest(z.unknown()),
);
