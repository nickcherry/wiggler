import { bullishBodyAlignmentFilter } from "@alea/lib/training/survivalFilters/bullishBodyAlignment/filter";
import { donchian50TopAlignmentFilter } from "@alea/lib/training/survivalFilters/donchian50TopAlignment/filter";
import { ema20AboveEma50AlignmentFilter } from "@alea/lib/training/survivalFilters/ema20AboveEma50Alignment/filter";
import { ema50SlopeAlignmentFilter } from "@alea/lib/training/survivalFilters/ema50SlopeAlignment/filter";
import { ema505mAlignmentFilter } from "@alea/lib/training/survivalFilters/ema505mAlignment/filter";
import { europeanSessionFilter } from "@alea/lib/training/survivalFilters/europeanSession/filter";
import { rangeExpansionFilter } from "@alea/lib/training/survivalFilters/rangeExpansion/filter";
import { roc205mAlignmentFilter } from "@alea/lib/training/survivalFilters/roc205mAlignment/filter";
import { rsi145mAlignmentFilter } from "@alea/lib/training/survivalFilters/rsi145mAlignment/filter";
import { stretchedFromEma50AlignmentFilter } from "@alea/lib/training/survivalFilters/stretchedFromEma50Alignment/filter";
import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";
import { volCompressionFilter } from "@alea/lib/training/survivalFilters/volCompression/filter";

/**
 * Active filters the dashboard renders. Two groups:
 *
 *   1. The reigning champion — `ema_50_5m_alignment` — at the top so
 *      its scores are always in the first comparison slot.
 *   2. 10 experimental filters being A/B'd against it: 4 trend
 *      variants, 2 momentum/extension, 4 orthogonal-mechanism
 *      (bar-shape, vol-event, vol-regime, time-of-day).
 *
 * Each filter lives in its own subdirectory under `survivalFilters/`
 * (`filter.ts` + `filter.test.ts`); registration here is what makes
 * the dashboard compute and display it. To freeze the active set,
 * comment out the imports + entries you don't want.
 */
export const survivalFilters: readonly SurvivalFilter[] = [
  // Reigning champion.
  ema505mAlignmentFilter,
  // Trend-direction variants.
  ema20AboveEma50AlignmentFilter,
  ema50SlopeAlignmentFilter,
  rsi145mAlignmentFilter,
  roc205mAlignmentFilter,
  // Range / extension.
  donchian50TopAlignmentFilter,
  stretchedFromEma50AlignmentFilter,
  // Bar-shape and vol-event.
  bullishBodyAlignmentFilter,
  rangeExpansionFilter,
  // Vol-regime and time-of-day (most orthogonal).
  volCompressionFilter,
  europeanSessionFilter,
  // Other implementations are on disk under `survivalFilters/`
  // (last3, last5, ma20, ma50, ema20) but unregistered.
];
