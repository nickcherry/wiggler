import type { CandleTimeframe } from "@alea/types/candles";

/**
 * Maps a alea timeframe to the `interval` query parameter accepted by the
 * Binance public klines endpoint.
 */
export function binanceInterval({
  timeframe,
}: {
  readonly timeframe: CandleTimeframe;
}): "1m" | "5m" {
  return timeframe;
}
