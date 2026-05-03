import type { CandleTimeframe } from "@alea/types/candles";

/**
 * Bar duration in milliseconds for a given candle timeframe.
 */
export function timeframeMs({
  timeframe,
}: {
  readonly timeframe: CandleTimeframe;
}): number {
  switch (timeframe) {
    case "1m":
      return 60_000;
    case "5m":
      return 300_000;
  }
}
