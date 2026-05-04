import type { ClosedFiveMinuteBar } from "@alea/lib/livePrices/types";

/**
 * Smoothing factor `α = 2 / (period + 1)` for an N-period EMA. Same
 * convention as the training pipeline (see `computeSurvivalSnapshots.ts`).
 */
const EMA_PERIOD = 50;
const EMA_ALPHA = 2 / (EMA_PERIOD + 1);

/**
 * Stateful EMA-50 tracker over completed 5m bars for one asset. Mirrors
 * the training pipeline's EMA convention exactly:
 *
 *   - seed = SMA of the first `EMA_PERIOD` bar closes;
 *   - thereafter: `EMA_t = α · close_t + (1 − α) · EMA_{t − 1}`;
 *   - `currentValue()` returns the EMA *through and including the most
 *     recent CLOSED bar*, so the live caller can use it as "the EMA
 *     evaluated just before the current 5m window starts" without any
 *     off-by-one arithmetic.
 *
 * Bars must be supplied strictly in ascending `openTimeMs` order. Out-of-
 * order or duplicate bars are dropped silently — common in practice when
 * a REST hydration overlaps with a streaming close, and we'd rather skip
 * the duplicate than corrupt the running EMA. The `lastBarOpenMs`
 * accessor lets callers skip duplicates explicitly when they have the
 * timestamp on hand.
 */
export type FiveMinuteEmaTracker = {
  /**
   * Append a closed bar. Returns `true` if the bar was incorporated and
   * `false` if it was a duplicate or out-of-order and dropped.
   */
  readonly append: (bar: ClosedFiveMinuteBar) => boolean;
  /**
   * Current EMA value, or `null` if fewer than `EMA_PERIOD` bars have
   * been seen.
   */
  readonly currentValue: () => number | null;
  /**
   * `openTimeMs` of the most recent bar incorporated, or `null` when
   * the tracker has not seen any bars yet.
   */
  readonly lastBarOpenMs: () => number | null;
  /**
   * Number of closed bars incorporated. Useful for log lines and the
   * cold-start health check.
   */
  readonly barCount: () => number;
};

export function createFiveMinuteEmaTracker(): FiveMinuteEmaTracker {
  // Seed buffer holds closes until the SMA seed is ready. Once the
  // tracker rolls into the EMA recurrence we stop touching this array.
  const seedCloses: number[] = [];
  let ema: number | null = null;
  let lastOpenMs: number | null = null;
  let count = 0;

  return {
    append: (bar) => {
      if (lastOpenMs !== null && bar.openTimeMs <= lastOpenMs) {
        return false;
      }
      lastOpenMs = bar.openTimeMs;
      count += 1;
      if (ema === null) {
        seedCloses.push(bar.close);
        if (seedCloses.length === EMA_PERIOD) {
          let sum = 0;
          for (const close of seedCloses) {
            sum += close;
          }
          ema = sum / EMA_PERIOD;
          // Empty the seed buffer to release the references.
          seedCloses.length = 0;
        }
        return true;
      }
      ema = EMA_ALPHA * bar.close + (1 - EMA_ALPHA) * ema;
      return true;
    },
    currentValue: () => ema,
    lastBarOpenMs: () => lastOpenMs,
    barCount: () => count,
  };
}
