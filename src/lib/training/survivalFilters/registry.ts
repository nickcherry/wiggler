import { last3x5mMajorityAlignmentFilter } from "@alea/lib/training/survivalFilters/last3x5mMajorityAlignment/filter";
import { ma205mAlignmentFilter } from "@alea/lib/training/survivalFilters/ma205mAlignment/filter";
import { prev5mDirectionAlignmentFilter } from "@alea/lib/training/survivalFilters/prev5mDirectionAlignment/filter";
import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

/**
 * Ordered list of filters the dashboard renders. Order is the order they
 * appear in the UI; pick the order to flow from the cheapest/most
 * intuitive (a single prior bar) to the most context-heavy (MA-20).
 *
 * Each filter lives in its own subdirectory under `survivalFilters/`,
 * with the implementation in `filter.ts` and the unit tests in
 * `filter.test.ts`. To add a new binary filter: drop a new subdirectory,
 * implement the `SurvivalFilter` interface, append the export here.
 *
 * All trend signals run on 5m bars rather than 1m: the survival snapshot
 * is sampled at 1m intervals inside the 5m window, but the "what's the
 * recent trend?" context is more meaningful at the 5m timeframe — that's
 * the cadence the actual market structure unfolds at.
 */
export const survivalFilters: readonly SurvivalFilter[] = [
  prev5mDirectionAlignmentFilter,
  last3x5mMajorityAlignmentFilter,
  ma205mAlignmentFilter,
];
