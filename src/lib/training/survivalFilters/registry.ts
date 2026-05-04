import { distanceFromLineAtrFilter } from "@alea/lib/training/survivalFilters/distanceFromLineAtr/filter";
import { ema505mAlignmentFilter } from "@alea/lib/training/survivalFilters/ema505mAlignment/filter";
import { roc20StrongAlignmentFilter } from "@alea/lib/training/survivalFilters/roc20StrongAlignment/filter";
import { rsiExtremeAgainstSideFilter } from "@alea/lib/training/survivalFilters/rsiExtremeAgainstSide/filter";
import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";
import { volCompressionFilter } from "@alea/lib/training/survivalFilters/volCompression/filter";

/**
 * Active filters the dashboard renders. Capped at 5: the top-4
 * overall performers from round 2's 15-filter A/B (2026-05) plus
 * EMA-50 (sacred — kept regardless of where it ranks). Round 2 was a
 * sweep — three of the four new top performers came from this round
 * (distance_from_line, roc-strong, rsi-extreme), with vol_compression
 * carrying over from round 1. EMA-50 ranked #9-11 across assets but
 * stays per the "always there" rule.
 *
 *   - distance_from_line_atr — runaway winner (~200-294 across all 5
 *     assets). Snapshots that have moved ≥0.5 ATR-14 from the line
 *     are decisively committed to a side; near-line snapshots are
 *     much more flip-prone.
 *   - roc_20_strong_alignment — strong second (~149-197). Threshold-
 *     gated momentum: only fires when |ROC-20| ≥ 0.5%, and asks
 *     whether the side matches that direction.
 *   - rsi_extreme_against_side — third (~93-145). Mean-reversion at
 *     RSI tails: fades 70+/30- readings.
 *   - vol_compression — round-1 winner (~99-129). Quiet markets
 *     hold direction better.
 *   - ema_50_5m_alignment — sacred. Original baby; still useful as
 *     a baseline trend signal even though newer filters score higher.
 *
 * Implementations of the round-2 losers (stretched_from_ema_50,
 * range_expansion, rsi_14, bb_position, ema_50_slope_strong,
 * both_emas, donchian_extreme, inside_bar, body_dominance,
 * rejection_wick) have been removed entirely. Older 5m-trend filters
 * (last_3, last_5, ma_20, ma_50, ema_20) remain on disk unregistered
 * for easy A/B reactivation if the question changes.
 */
export const survivalFilters: readonly SurvivalFilter[] = [
  ema505mAlignmentFilter,
  distanceFromLineAtrFilter,
  roc20StrongAlignmentFilter,
  rsiExtremeAgainstSideFilter,
  volCompressionFilter,
];
