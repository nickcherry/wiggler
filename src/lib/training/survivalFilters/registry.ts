import { donchian50TopAlignmentFilter } from "@alea/lib/training/survivalFilters/donchian50TopAlignment/filter";
import { ema505mAlignmentFilter } from "@alea/lib/training/survivalFilters/ema505mAlignment/filter";
import { rangeExpansionFilter } from "@alea/lib/training/survivalFilters/rangeExpansion/filter";
import { rsi145mAlignmentFilter } from "@alea/lib/training/survivalFilters/rsi145mAlignment/filter";
import { stretchedFromEma50AlignmentFilter } from "@alea/lib/training/survivalFilters/stretchedFromEma50Alignment/filter";
import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";
import { volCompressionFilter } from "@alea/lib/training/survivalFilters/volCompression/filter";

/**
 * Active filters the dashboard renders. Selected as the union of the
 * top-5 by max |score| across each of the 5 active assets after the
 * 10-filter A/B in 2026-05:
 *
 *   - vol_compression — clear winner across every asset (~99–129 score
 *     range, 2-3× EMA-50). Quiet markets hold direction better.
 *   - stretched_from_ema_50 — strong second; mean-reversion signal
 *     when price is ≥1 ATR-14 from the EMA-50.
 *   - range_expansion — vol-event signal; strong magnitude on the
 *     "after-spike" half but only ~12% occurrence.
 *   - ema_50_5m_alignment — kept regardless; the original baby and
 *     still solidly top-5 on every asset.
 *   - rsi_14 — top-5 on every asset.
 *   - donchian_50_top — top-5 only on SOL but kept since the union
 *     of per-asset top-5s permits per-asset variance.
 *
 * Implementations of the filters that didn't make the cut
 * (ema_20_above_ema_50, ema_50_slope, roc_20, bullish_body,
 * european_session) have been removed entirely. Older 5m-trend
 * filters (last_3, last_5, ma_20, ma_50, ema_20) remain on disk
 * unregistered for easy A/B reactivation if the question changes.
 */
export const survivalFilters: readonly SurvivalFilter[] = [
  volCompressionFilter,
  stretchedFromEma50AlignmentFilter,
  rangeExpansionFilter,
  ema505mAlignmentFilter,
  rsi145mAlignmentFilter,
  donchian50TopAlignmentFilter,
];
