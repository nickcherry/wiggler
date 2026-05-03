import type { CandleTimeframe } from "@alea/types/candles";

/**
 * Maps a alea timeframe to the granularity string accepted by the Coinbase
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
