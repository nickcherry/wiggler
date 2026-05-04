import { distanceFromLineAtrFilter } from "@alea/lib/training/survivalFilters/distanceFromLineAtr/filter";
import { ema505mAlignmentFilter } from "@alea/lib/training/survivalFilters/ema505mAlignment/filter";
import { rangeWithinAtrFilter } from "@alea/lib/training/survivalFilters/rangeWithinAtr/filter";
import { roc5StrongAlignedFilter } from "@alea/lib/training/survivalFilters/roc5StrongAligned/filter";
import { rsiExtremeAgainstSideFilter } from "@alea/lib/training/survivalFilters/rsiExtremeAgainstSide/filter";
import { stochasticExtremeAgainstFilter } from "@alea/lib/training/survivalFilters/stochasticExtremeAgainst/filter";
import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";
import { utcHourUsSessionFilter } from "@alea/lib/training/survivalFilters/utcHourUsSession/filter";
import { volCompressionFilter } from "@alea/lib/training/survivalFilters/volCompression/filter";
import { weekendSessionFilter } from "@alea/lib/training/survivalFilters/weekendSession/filter";

/**
 * Active filters the dashboard renders. Nine after round 4's
 * 18-filter A/B (2026-05): seven carryovers from round 3, two new
 * round-4 winners, and the sacred EMA-50.
 *
 *   - distance_from_line_atr — runaway winner across all rounds
 *     (200-294); decisively-displaced snapshots are decisively
 *     committed.
 *   - roc_5_strong_aligned — NEW in round 4 (143-221). Threshold-
 *     gated momentum at 25-min lookback; replaces round-2's
 *     `roc_20_strong_alignment` (longer-window sibling) which it
 *     beat on 4 of 5 assets.
 *   - rsi_extreme_against_side — RSI-tail mean reversion (93-145).
 *   - vol_compression — round-1 carryover (98-129); quiet markets
 *     hold direction better.
 *   - weekend_session — round-3 carryover (66-88). Crypto weekend
 *     microstructure.
 *   - utc_hour_us_session — round-3 carryover (54-79). NYSE-hours
 *     bias when crypto correlates with stocks.
 *   - stochastic_extreme_against — round-3 carryover (32-80). Mean
 *     reversion at stoch %K extremes.
 *   - range_within_atr — NEW in round 4 (29-56). Bar-level
 *     compression: tight last bar (range < 0.5 × ATR) signals
 *     either coil-and-resolve or low-conviction follow-through.
 *   - ema_50_5m_alignment — sacred. Original baby; baseline trend
 *     signal in the lineup.
 *
 * Round-4 dropouts: roc_20_strong_alignment (obsoleted by roc_5),
 * vol_expansion (highly variable; near-zero on 4 of 5 assets — the
 * top-tail vol regime is too rare to score), stochastic_aligned
 * (oscillator direction-mode lost just like RSI direction-mode in
 * round 2), distance_from_ema20_atr (redundant with line-distance
 * winner), and 5 weak time-of-day / day-of-week cuts (Asian,
 * London, after-US-close, Friday, Monday — all ranked below the
 * existing weekend + US-session pair).
 *
 * Older 5m-trend filters (last_3, last_5, ma_20, ma_50, ema_20)
 * remain on disk unregistered.
 */
export const survivalFilters: readonly SurvivalFilter[] = [
  ema505mAlignmentFilter,
  distanceFromLineAtrFilter,
  roc5StrongAlignedFilter,
  rsiExtremeAgainstSideFilter,
  volCompressionFilter,
  weekendSessionFilter,
  utcHourUsSessionFilter,
  stochasticExtremeAgainstFilter,
  rangeWithinAtrFilter,
];
