import { bullishBodyAlignmentFilter } from "@alea/lib/training/survivalFilters/bullishBodyAlignment/filter";
import { distanceAtrWithEmaAlignedFilter } from "@alea/lib/training/survivalFilters/distanceAtrWithEmaAligned/filter";
import { distanceFromLineAtrFilter } from "@alea/lib/training/survivalFilters/distanceFromLineAtr/filter";
import { donchian50TopAlignmentFilter } from "@alea/lib/training/survivalFilters/donchian50TopAlignment/filter";
import { ema20AboveEma50AlignmentFilter } from "@alea/lib/training/survivalFilters/ema20AboveEma50Alignment/filter";
import { ema50SlopeAlignmentFilter } from "@alea/lib/training/survivalFilters/ema50SlopeAlignment/filter";
import { ema205mAlignmentFilter } from "@alea/lib/training/survivalFilters/ema205mAlignment/filter";
import { ema505mAlignmentFilter } from "@alea/lib/training/survivalFilters/ema505mAlignment/filter";
import { europeanSessionFilter } from "@alea/lib/training/survivalFilters/europeanSession/filter";
import { last3x5mMajorityAlignmentFilter } from "@alea/lib/training/survivalFilters/last3x5mMajorityAlignment/filter";
import { last5x5mMajorityAlignmentFilter } from "@alea/lib/training/survivalFilters/last5x5mMajorityAlignment/filter";
import { ma205mAlignmentFilter } from "@alea/lib/training/survivalFilters/ma205mAlignment/filter";
import { ma505mAlignmentFilter } from "@alea/lib/training/survivalFilters/ma505mAlignment/filter";
import { prev5mDirectionAlignmentFilter } from "@alea/lib/training/survivalFilters/prev5mDirectionAlignment/filter";
import { rangeExpansionFilter } from "@alea/lib/training/survivalFilters/rangeExpansion/filter";
import { rangeWithinAtrFilter } from "@alea/lib/training/survivalFilters/rangeWithinAtr/filter";
import { recentBreakoutAlignedFilter } from "@alea/lib/training/survivalFilters/recentBreakoutAligned/filter";
import { roc5StrongAlignedFilter } from "@alea/lib/training/survivalFilters/roc5StrongAligned/filter";
import { roc20StrongAlignmentFilter } from "@alea/lib/training/survivalFilters/roc20StrongAlignment/filter";
import { roc205mAlignmentFilter } from "@alea/lib/training/survivalFilters/roc205mAlignment/filter";
import { rsi145mAlignmentFilter } from "@alea/lib/training/survivalFilters/rsi145mAlignment/filter";
import { rsiExtremeAgainstSideFilter } from "@alea/lib/training/survivalFilters/rsiExtremeAgainstSide/filter";
import { stochasticExtremeAgainstFilter } from "@alea/lib/training/survivalFilters/stochasticExtremeAgainst/filter";
import { stretchedFromEma50AlignmentFilter } from "@alea/lib/training/survivalFilters/stretchedFromEma50Alignment/filter";
import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";
import { utcHourUsSessionFilter } from "@alea/lib/training/survivalFilters/utcHourUsSession/filter";
import { volCompressionFilter } from "@alea/lib/training/survivalFilters/volCompression/filter";
import { volumeHighAlignedFilter } from "@alea/lib/training/survivalFilters/volumeHighAligned/filter";
import { weekendSessionFilter } from "@alea/lib/training/survivalFilters/weekendSession/filter";

/**
 * Broadened registry: every filter we've ever shipped, registered for
 * re-evaluation under the new conditioned-baseline scoring (which is
 * not directly comparable to the old global-baseline scores that drove
 * past prune decisions). Once we look at the new data and pick the
 * keepers, this list can be trimmed back down to the dashboard's
 * "active" set.
 *
 * Three groups, in order:
 *   1. The ten currently-active dashboard filters (round-5 winners +
 *      sacred EMA-50). Same order as before so the active list reads
 *      the same.
 *   2. Five filters whose code stayed on disk but were unregistered
 *      after earlier rounds (`last_3` / `last_5` majority, `ma_20` /
 *      `ma_50` / `ema_20` 5m alignment).
 *   3. Thirteen filters fully deleted in earlier prune commits and
 *      now restored from git history. `prev_5m_direction_alignment`
 *      had to be adapted — the `context.prev5mDirection` field it
 *      relied on was replaced by `context.prev5mBar`, so the filter
 *      now derives direction from `prev5mBar.close >= prev5mBar.open`.
 */
export const survivalFilters: readonly SurvivalFilter[] = [
  // --- Active dashboard filters -------------------------------------
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
  // --- Unregistered (5m-trend cousins of EMA-50) --------------------
  ema205mAlignmentFilter,
  ma205mAlignmentFilter,
  ma505mAlignmentFilter,
  last3x5mMajorityAlignmentFilter,
  last5x5mMajorityAlignmentFilter,
  // --- Restored from earlier prune commits --------------------------
  bullishBodyAlignmentFilter,
  donchian50TopAlignmentFilter,
  ema20AboveEma50AlignmentFilter,
  ema50SlopeAlignmentFilter,
  europeanSessionFilter,
  prev5mDirectionAlignmentFilter,
  rangeExpansionFilter,
  rangeWithinAtrFilter,
  roc205mAlignmentFilter,
  roc20StrongAlignmentFilter,
  rsi145mAlignmentFilter,
  stochasticExtremeAgainstFilter,
  stretchedFromEma50AlignmentFilter,
];
