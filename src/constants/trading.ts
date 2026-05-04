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
 * Minimum bp distance from the price line at which we'll *engage* —
 * either count the snapshot toward training calibration or act on it
 * in live trading. Snapshots within `[0, MIN_ACTIONABLE_DISTANCE_BP)`
 * bp of the line are treated as if they don't exist for both purposes.
 *
 * Why: very near the line, win-rate is mechanically close to 50/50
 * regardless of filter (the price hasn't committed). Predictions
 * there carry no real edge over a coinflip, and the sample-rich noise
 * floor was inflating headline numbers in earlier versions of the
 * scoring. Excluding this band is a cleaner statement of "don't trade
 * when it could go either way" than relying on the modeled edge to
 * happen to fall below `MIN_EDGE` for those buckets.
 *
 * Set to 2 bp (≈$20 on a $100k BTC line). Bumping this value is a
 * meaningful policy change — it directly shrinks the actionable
 * snapshot population — so it lives here as a committed constant
 * rather than a flag.
 *
 * Both the training-side scoring (`computeSweetSpot`,
 * `scoreHalfVsBaseline`, `natsSavedVsGlobal`) and the live trader
 * (`evaluateDecision` skip rule, plus the probability-table
 * generation that drops sub-floor buckets) reference this constant
 * directly so the rule is identical end-to-end.
 */
export const MIN_ACTIONABLE_DISTANCE_BP = 2;

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

/**
 * Fixed USD stake per trade. Hardcoded on purpose: this is part of the
 * trading strategy, not an operational knob. Bumping this number is a
 * code change and a reviewable diff.
 */
export const STAKE_USD = 20;

/**
 * Polymarket maker fee rate as a fraction (1.0 = 100%). Applied as
 * `cost * MAKER_FEE_RATE` in PnL accounting. Polymarket's standard
 * crypto up/down markets currently charge 0% maker fees — we wire the
 * constant through anyway so the formula is correct if the venue ever
 * starts charging.
 *
 * Taker fees can be up to 7% on these markets, which is why we are
 * exclusively maker. See the order placement code for the constraint.
 */
export const MAKER_FEE_RATE = 0;

/**
 * Margin (in milliseconds) before the 5m window close at which the
 * runner cancels any still-resting limit orders. Cancelling slightly
 * early avoids racing the venue's own market-close cleanup and keeps
 * our in-memory state in sync with the truth on Polymarket.
 */
export const ORDER_CANCEL_MARGIN_MS = 10_000;

/**
 * Margin (in milliseconds) after the 5m window close at which the
 * runner emits the window summary. We give Polymarket a few seconds
 * to settle the market and the user WS channel a few seconds to
 * deliver any final fill notifications, so the summary line is
 * already accurate when it ships to Telegram.
 */
export const WINDOW_SUMMARY_DELAY_MS = 8_000;

/**
 * The settlement payout for a winning YES token, expressed in USDC.
 * Hardcoded here so the PnL math has a named reference point —
 * Polymarket has always paid $1 per winning YES, but the constant
 * makes that assumption visible in diffs.
 */
export const WINNING_YES_PAYOUT_USD = 1;
