import { timeframeMs } from "@alea/lib/candles/timeframeMs";
import type { CandleTimeframe } from "@alea/types/candles";

/**
 * Floors `date` to the most recently completed timeframe boundary so that
 * fetched candles align cleanly with bar starts.
 */
export function alignTimeframeWindow({
  date,
  timeframe,
}: {
  readonly date: Date;
  readonly timeframe: CandleTimeframe;
}): Date {
  const ms = timeframeMs({ timeframe });
  const aligned = Math.floor(date.getTime() / ms) * ms;
  return new Date(aligned);
}
