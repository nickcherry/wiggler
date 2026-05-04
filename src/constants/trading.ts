/**
 * Live-trading tuning constants. Deliberately not env-driven — every value
 * here is part of the trading strategy itself, so it is committed to version
 * control and reviewable in diffs. Operational secrets (wallet keys, db
 * urls) still live in `env.ts`; nothing about *how* the bot trades does.
 */

/**
 * Minimum sample count for a probability-table bucket to be considered
 * tradable. Buckets thinner than this fall in the noisy tail of the
 * distribution (very-far-from-line distances with only a handful of
 * historical observations); we treat them as "no signal" and never trade.
 */
export const MIN_BUCKET_SAMPLES = 200;

/**
 * Minimum edge over the market for the bot to take a trade. "Edge" =
 * `ourProbability − marketImpliedProbability` for the side we'd buy.
 * Below this threshold we don't bother — the spread, slippage, and
 * model error eat any thin edge.
 *
 * Expressed as an absolute probability gap (e.g. `0.05` = 5pp). Tune
 * this against backtests and live calibration.
 */
export const MIN_EDGE = 0.05;

/**
 * Number of completed 5-minute closes the live runner needs to bootstrap
 * its EMA-50 from. The EMA seed needs 50 bars; we pull a comfortable
 * margin so any single missed bar over the wire doesn't stall the seed.
 */
export const EMA50_BOOTSTRAP_BARS = 60;
