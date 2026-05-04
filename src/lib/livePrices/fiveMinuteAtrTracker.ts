import { LIVE_TRADING_ATR_PERIOD } from "@alea/constants/liveTrading";
import type { ClosedFiveMinuteBar } from "@alea/lib/livePrices/types";

/**
 * Period for the live ATR tracker. Sourced from
 * `LIVE_TRADING_ATR_PERIOD` so it stays in lockstep with the filter
 * that powers the persisted probability table. Live and training MUST
 * use the same period so the live filter classification matches the
 * historical classifications baked into the table.
 */
const ATR_PERIOD = LIVE_TRADING_ATR_PERIOD;

/**
 * Stateful Wilder ATR tracker over completed 5m bars for one asset
 * at the period configured for live trading
 * (`LIVE_TRADING_ATR_PERIOD`).
 * Mirrors the training pipeline's ATR convention exactly:
 *
 *   - True range per bar:
 *       `TR = max(high − low, |high − prevClose|, |prevClose − low|)`
 *     For the very first bar (no prior close), `TR = high − low`.
 *   - Seed: simple average of the first `ATR_PERIOD` true ranges.
 *   - Recurrence: `ATR_t = ((N − 1) · ATR_{t − 1} + TR_t) / N`.
 *   - `currentValue()` returns the ATR *through and including the most
 *     recent CLOSED bar*, so the live caller can use it as "the ATR
 *     evaluated just before the current 5m window starts" without any
 *     off-by-one arithmetic.
 *
 * Bars must be supplied strictly in ascending `openTimeMs` order.
 * Out-of-order or duplicate bars are dropped silently — common in
 * practice when a REST hydration overlaps with a streaming close, and
 * we'd rather skip the duplicate than corrupt the running ATR.
 *
 * Memory is O(1) after warmup: the tracker holds the running ATR plus
 * the previous bar's close for the next true-range calculation. It
 * does not retain a sliding window of bars.
 */
export type FiveMinuteAtrTracker = {
  /**
   * Append a closed bar. Returns `true` if the bar was incorporated and
   * `false` if it was a duplicate or out-of-order and dropped.
   */
  readonly append: (bar: ClosedFiveMinuteBar) => boolean;
  /**
   * Current ATR value, or `null` if fewer than `ATR_PERIOD` bars have
   * been seen.
   */
  readonly currentValue: () => number | null;
  /**
   * `openTimeMs` of the most recent bar incorporated, or `null` when
   * the tracker has not seen any bars yet.
   */
  readonly lastBarOpenMs: () => number | null;
  /** Number of closed bars incorporated. */
  readonly barCount: () => number;
};

export function createFiveMinuteAtrTracker(): FiveMinuteAtrTracker {
  // Seed buffer holds true ranges until the simple-average seed is
  // ready. Once the tracker rolls into the Wilder recurrence we stop
  // touching this array.
  const seedTrueRanges: number[] = [];
  let atr: number | null = null;
  let prevClose: number | null = null;
  let lastOpenMs: number | null = null;
  let count = 0;

  return {
    append: (bar) => {
      if (lastOpenMs !== null && bar.openTimeMs <= lastOpenMs) {
        return false;
      }
      lastOpenMs = bar.openTimeMs;
      count += 1;
      // For the first bar (no prior close), TR is just high − low.
      // Mirrors the training pipeline's behaviour at index 0.
      const tr =
        prevClose === null
          ? bar.high - bar.low
          : Math.max(
              bar.high - bar.low,
              Math.abs(bar.high - prevClose),
              Math.abs(prevClose - bar.low),
            );
      prevClose = bar.close;
      if (atr === null) {
        seedTrueRanges.push(tr);
        if (seedTrueRanges.length === ATR_PERIOD) {
          let sum = 0;
          for (const v of seedTrueRanges) {
            sum += v;
          }
          atr = sum / ATR_PERIOD;
          // Empty the seed buffer to release the references.
          seedTrueRanges.length = 0;
        }
        return true;
      }
      atr = (atr * (ATR_PERIOD - 1) + tr) / ATR_PERIOD;
      return true;
    },
    currentValue: () => atr,
    lastBarOpenMs: () => lastOpenMs,
    barCount: () => count,
  };
}
