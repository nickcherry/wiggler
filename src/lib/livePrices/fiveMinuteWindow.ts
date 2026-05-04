/**
 * UTC 5-minute window arithmetic used everywhere in the live trader.
 * Both Polymarket's up/down markets and our training pipeline align to
 * `floor(unixSeconds / 300) * 300`, so a single helper covers both
 * boundary conventions. Pure, deterministic, no implicit "now" — every
 * call site must pass the timestamp in.
 */

export const FIVE_MINUTES_MS = 5 * 60 * 1000;

/**
 * Returns the start (in epoch ms) of the 5m window containing `nowMs`.
 * For a `nowMs` that lands exactly on a 5m boundary, returns that
 * boundary itself.
 */
export function currentWindowStartMs({
  nowMs,
}: {
  readonly nowMs: number;
}): number {
  return Math.floor(nowMs / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
}

/**
 * Returns the start of the next 5m window strictly after `nowMs`.
 * Useful for scheduling "wake me at the top of the next bar" timers
 * and for pre-fetching the upcoming Polymarket market 30s ahead.
 */
export function nextWindowStartMs({
  nowMs,
}: {
  readonly nowMs: number;
}): number {
  return currentWindowStartMs({ nowMs }) + FIVE_MINUTES_MS;
}

/**
 * Milliseconds until `windowStartMs + 5min` from `nowMs`. Negative when
 * the window has already closed; clamp at the call site if needed.
 */
export function remainingInWindowMs({
  windowStartMs,
  nowMs,
}: {
  readonly windowStartMs: number;
  readonly nowMs: number;
}): number {
  return windowStartMs + FIVE_MINUTES_MS - nowMs;
}

/**
 * Floors `(windowStartMs + 5min - nowMs)` down to one of {1, 2, 3, 4}
 * minutes — the same buckets the probability table is keyed by.
 *
 *   - During [+0:00, +1:00) → remaining = 4
 *   - During [+1:00, +2:00) → remaining = 3
 *   - During [+2:00, +3:00) → remaining = 2
 *   - During [+3:00, +4:00) → remaining = 1
 *   - At/past +4:00         → null (out of trading window)
 *
 * Returning `null` rather than 0 makes the "no longer tradable" state
 * unambiguous in call-site control flow.
 */
export function flooredRemainingMinutes({
  windowStartMs,
  nowMs,
}: {
  readonly windowStartMs: number;
  readonly nowMs: number;
}): 1 | 2 | 3 | 4 | null {
  const elapsedMs = nowMs - windowStartMs;
  if (elapsedMs < 0 || elapsedMs >= 4 * 60_000) {
    return null;
  }
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  const remaining = 4 - elapsedMinutes;
  if (
    remaining === 1 ||
    remaining === 2 ||
    remaining === 3 ||
    remaining === 4
  ) {
    return remaining;
  }
  return null;
}
