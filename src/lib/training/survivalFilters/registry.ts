import { last3x1mMajorityAlignmentFilter } from "@alea/lib/training/survivalFilters/last3x1mMajorityAlignment";
import { ma205mAlignmentFilter } from "@alea/lib/training/survivalFilters/ma205mAlignment";
import { prev1mDirectionAlignmentFilter } from "@alea/lib/training/survivalFilters/prev1mDirectionAlignment";
import { prev5mDirectionAlignmentFilter } from "@alea/lib/training/survivalFilters/prev5mDirectionAlignment";
import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

/**
 * Ordered list of filters the dashboard renders. Order is the order they
 * appear in the UI; pick the order to flow from cheapest/most intuitive
 * (prior 1m) to most context-heavy (MA-20).
 *
 * To add a new binary filter: implement the `SurvivalFilter` interface in
 * a new sibling file and append it here. No other touch-points required —
 * the runner discovers filters from this list and the renderer iterates
 * the resulting `SurvivalFilterResult[]` generically.
 */
export const survivalFilters: readonly SurvivalFilter[] = [
  prev1mDirectionAlignmentFilter,
  last3x1mMajorityAlignmentFilter,
  prev5mDirectionAlignmentFilter,
  ma205mAlignmentFilter,
];
