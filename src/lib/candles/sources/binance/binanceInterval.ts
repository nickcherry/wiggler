import type { CandleTimeframe } from "@wiggler/types/candles";

/**
 * Maps a wiggler timeframe to the `interval` query parameter accepted by the
 * Binance public klines endpoint.
 */
export function binanceInterval({
  timeframe,
}: {
  readonly timeframe: CandleTimeframe;
}): "1m" | "5m" {
  return timeframe;
}
