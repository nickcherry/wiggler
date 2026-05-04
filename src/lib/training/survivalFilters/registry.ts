import { ema505mAlignmentFilter } from "@alea/lib/training/survivalFilters/ema505mAlignment/filter";
import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

/**
 * Ordered list of filters the dashboard renders. Each filter lives in
 * its own subdirectory under `survivalFilters/` (`filter.ts` +
 * `filter.test.ts`); registration here is what makes the dashboard
 * compute and display it. To re-enable a filter that exists on disk
 * but isn't currently being computed, just import it and append.
 *
 * Active set:
 *   - ema_50_5m_alignment — strongest filter we have so far across
 *     every asset, by signed-area score (positive ~ +37, negative ~
 *     −40 at 4m left for BTC; consistently leads the others on ETH/
 *     SOL/XRP/DOGE too). The other 5 filters
 *     (last_3_5m_majority, last_5_5m_majority, ma_20_5m, ma_50_5m,
 *     ema_20_5m) are unregistered to keep the dashboard focused —
 *     they're heavily correlated with EMA-50 but consistently weaker.
 *     Their implementations remain on disk for easy re-enabling if
 *     we want to A/B them again later.
 */
export const survivalFilters: readonly SurvivalFilter[] = [
  ema505mAlignmentFilter,
];
