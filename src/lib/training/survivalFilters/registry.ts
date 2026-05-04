import { distanceFromLineAtrFilter } from "@alea/lib/training/survivalFilters/distanceFromLineAtr/filter";
import { ema505mAlignmentFilter } from "@alea/lib/training/survivalFilters/ema505mAlignment/filter";
import { roc20StrongAlignmentFilter } from "@alea/lib/training/survivalFilters/roc20StrongAlignment/filter";
import { rsiExtremeAgainstSideFilter } from "@alea/lib/training/survivalFilters/rsiExtremeAgainstSide/filter";
import { stochasticExtremeAgainstFilter } from "@alea/lib/training/survivalFilters/stochasticExtremeAgainst/filter";
import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";
import { utcHourUsSessionFilter } from "@alea/lib/training/survivalFilters/utcHourUsSession/filter";
import { volCompressionFilter } from "@alea/lib/training/survivalFilters/volCompression/filter";
import { weekendSessionFilter } from "@alea/lib/training/survivalFilters/weekendSession/filter";

/**
 * Active filters the dashboard renders. Eight after round 3's
 * 15-filter A/B (2026-05): five carryovers from round 2 plus three
 * new ones that scored in the top half across every asset. EMA-50
 * stays regardless per the sacred rule.
 *
 *   - distance_from_line_atr — runaway winner (200-294 across all
 *     assets); decisively-displaced snapshots are decisively committed.
 *   - roc_20_strong_alignment — strong second (149-197); threshold-
 *     gated momentum that fires only when |ROC-20| ≥ 0.5%.
 *   - rsi_extreme_against_side — RSI-tail mean reversion (93-145).
 *   - vol_compression — round-1 carryover (98-129); quiet markets
 *     hold direction better.
 *   - weekend_session — new in round 3 (66-88). Crypto-specific
 *     weekend microstructure. Top-5 every asset.
 *   - utc_hour_us_session — new (54-79). NYSE-hours bias when
 *     crypto correlates with stocks.
 *   - stochastic_extreme_against — new (32-80). Mean reversion at
 *     stoch-%K extremes; orthogonal mechanism to RSI even when they
 *     agree on direction.
 *   - ema_50_5m_alignment — sacred. Original baby; keeps a baseline
 *     trend signal in the lineup.
 *
 * Round-3 dropouts (gone for good): streak_3, streak_5,
 * majority_aligned_10 (directional persistence proved weaker than
 * time-of-day cuts), roc_acceleration_aligned (ROC5 vs ROC20
 * carried less signal than absolute ROC magnitude),
 * vol_compression_with_ema50_aligned (compounds dilute, not amplify,
 * the parent winners), distance_from_line_atr_strong (1.5 ATR
 * threshold leaves true/false halves with no overlapping bp buckets,
 * so the area-vs-baseline scoring degenerates to 0), and
 * distance_from_line_bp_30 (raw-bp variant has the same overlap
 * problem; ATR normalization is what makes the original work).
 *
 * Older 5m-trend filters (last_3, last_5, ma_20, ma_50, ema_20)
 * remain on disk unregistered in case the question changes.
 */
export const survivalFilters: readonly SurvivalFilter[] = [
  ema505mAlignmentFilter,
  distanceFromLineAtrFilter,
  roc20StrongAlignmentFilter,
  rsiExtremeAgainstSideFilter,
  volCompressionFilter,
  weekendSessionFilter,
  utcHourUsSessionFilter,
  stochasticExtremeAgainstFilter,
];
