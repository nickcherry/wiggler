import { distanceAtrWithEmaAlignedFilter } from "@alea/lib/training/survivalFilters/distanceAtrWithEmaAligned/filter";
import { distanceFromLineAtrFilter } from "@alea/lib/training/survivalFilters/distanceFromLineAtr/filter";
import { ema505mAlignmentFilter } from "@alea/lib/training/survivalFilters/ema505mAlignment/filter";
import { recentBreakoutAlignedFilter } from "@alea/lib/training/survivalFilters/recentBreakoutAligned/filter";
import { roc5StrongAlignedFilter } from "@alea/lib/training/survivalFilters/roc5StrongAligned/filter";
import { rsiExtremeAgainstSideFilter } from "@alea/lib/training/survivalFilters/rsiExtremeAgainstSide/filter";
import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";
import { utcHourUsSessionFilter } from "@alea/lib/training/survivalFilters/utcHourUsSession/filter";
import { volCompressionFilter } from "@alea/lib/training/survivalFilters/volCompression/filter";
import { volumeHighAlignedFilter } from "@alea/lib/training/survivalFilters/volumeHighAligned/filter";
import { weekendSessionFilter } from "@alea/lib/training/survivalFilters/weekendSession/filter";

/**
 * Active filters the dashboard renders. Ten after round 5's
 * 19-filter A/B (2026-05): seven carryovers, three new round-5
 * winners, and the sacred EMA-50.
 *
 *   - distance_from_line_atr — runaway winner across all rounds
 *     (200-294); decisively-displaced snapshots are decisively
 *     committed.
 *   - roc_5_strong_aligned — round-4 winner (143-221). 25-min
 *     threshold-gated momentum.
 *   - distance_atr_with_ema_aligned — NEW in round 5 (130-200).
 *     The compound that finally worked: positional (≥0.5 ATR from
 *     line) AND directional (side aligned with EMA-50). Earlier
 *     compounds failed because the parents shared too much
 *     population; here the two mechanisms are genuinely
 *     orthogonal.
 *   - rsi_extreme_against_side — RSI-tail mean reversion (93-145).
 *   - vol_compression — round-1 carryover (98-129); quiet markets
 *     hold direction better.
 *   - volume_high_aligned — NEW in round 5 (85-117). Volume-
 *     confirmed continuation: high-vol bar in the side's direction
 *     means real flow agrees.
 *   - recent_breakout_aligned — NEW in round 5 (76-101). Fresh
 *     50-bar high/low within the last 5 bars + side aligned with
 *     that extreme. Different from the dropped donchian_extreme
 *     (proximity-in-space) — this is proximity-in-time.
 *   - weekend_session — round-3 carryover (66-88). Crypto weekend
 *     microstructure.
 *   - utc_hour_us_session — round-3 carryover (54-79). NYSE-hours
 *     bias.
 *   - ema_50_5m_alignment — sacred. Original baby; baseline trend
 *     signal in the lineup.
 *
 * Round-5 displacements:
 *   - stochastic_extreme_against (round-3 winner) — knocked out;
 *     avg 57 vs utc_hour_us_session's 67 across assets.
 *   - range_within_atr (round-4 winner) — knocked out as the
 *     weakest carryover; bar-level compression isn't strong
 *     enough versus the new compound + volume + breakout
 *     mechanisms.
 *
 * Round-5 dropouts (gone for good): volume_high_against_side
 * (weaker than the aligned variant), volume_low, distance_growing
 * + micro_velocity_aligned (within-window microstructure works but
 * not strongly enough — both ~44–73), range_contraction,
 * utc_hour_settlement (narrow band didn't add over US session),
 * utc_midnight (clear loser, 6–9 across assets).
 *
 * Older 5m-trend filters (last_3, last_5, ma_20, ma_50, ema_20)
 * remain on disk unregistered.
 */
export const survivalFilters: readonly SurvivalFilter[] = [
  ema505mAlignmentFilter,
  distanceFromLineAtrFilter,
  roc5StrongAlignedFilter,
  distanceAtrWithEmaAlignedFilter,
  rsiExtremeAgainstSideFilter,
  volCompressionFilter,
  volumeHighAlignedFilter,
  recentBreakoutAlignedFilter,
  weekendSessionFilter,
  utcHourUsSessionFilter,
];
