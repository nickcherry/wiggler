import { distanceFromLineAtrFilter } from "@alea/lib/training/survivalFilters/distanceFromLineAtr/filter";
import { ema505mAlignmentFilter } from "@alea/lib/training/survivalFilters/ema505mAlignment/filter";
import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

/**
 * The active filter set. Two filters today, narrowed down from the 28
 * we'd shipped historically after the 2026-05-04 scoring overhaul (see
 * [doc/research/2026-05-04-filter-archive.md](../../../../doc/research/2026-05-04-filter-archive.md)
 * for the calibration table that drove the prune):
 *
 *   - `distance_from_line_atr` — the training-side champion. Universal
 *     coverage, ~0.6–0.9% calibration improvement vs no-filter across
 *     all five assets, the strongest single filter we've found.
 *   - `ema_50_5m_alignment` — kept registered because the live trader's
 *     `aligned` term in `src/lib/trading/computeAssetProbabilities.ts`
 *     calls `.classify()` on this filter directly. It's also useful to
 *     have on the dashboard as the head-to-head benchmark for any
 *     future filter we evaluate.
 *
 * The other 26 retired filters are documented (with per-asset scores
 * and per-filter intuition) in the filter archive linked above. Their
 * source code can be recovered by `git log -p` on
 * `src/lib/training/survivalFilters/<name>/`.
 *
 * Future compound filters should be appended here. Keep the active set
 * small — every filter in this list is computed for every snapshot at
 * `training:distributions` time, and the dashboard renders one section
 * per filter. The signal-to-noise on the dashboard depends on the list
 * staying focused.
 */
export const survivalFilters: readonly SurvivalFilter[] = [
  distanceFromLineAtrFilter,
  ema505mAlignmentFilter,
];
