import type { CandleTimeframe } from "@wiggler/types/candles";

/**
 * Maps a wiggler timeframe to the granularity string accepted by the Coinbase
 * Advanced Trade candles endpoint.
 */
export function coinbaseGranularity({
  timeframe,
}: {
  readonly timeframe: CandleTimeframe;
}): "ONE_MINUTE" | "FIVE_MINUTE" {
  switch (timeframe) {
    case "1m":
      return "ONE_MINUTE";
    case "5m":
      return "FIVE_MINUTE";
  }
}
