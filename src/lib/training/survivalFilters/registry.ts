import { distanceFromLineAtrFilter } from "@alea/lib/training/survivalFilters/distanceFromLineAtr/filter";
import {
  distanceFromLineAtr3Filter,
  distanceFromLineAtr4Filter,
} from "@alea/lib/training/survivalFilters/distanceFromLineAtrCandidates/filter";
import { ema505mAlignmentFilter } from "@alea/lib/training/survivalFilters/ema505mAlignment/filter";
import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

/**
 * The active dashboard filter set. It stays focused on production
 * candidates and direct comparators, narrowed down from the 28 we'd
 * shipped historically after the 2026-05-04 scoring overhaul (see
 * [doc/research/2026-05-04-filter-archive.md](../../../../doc/research/2026-05-04-filter-archive.md)
 * for the calibration table that drove the prune):
 *
 *   - `distance_from_line_atr_3` — the latest training-side candidate.
 *     The 2026-05-04 ATR period sweep found it beats ATR-14 on all five
 *     assets and wins the equal-asset average.
 *   - `distance_from_line_atr_4` — near-tied comparator. It won more
 *     individual assets than ATR-3 but slightly trailed the equal-asset
 *     average.
 *   - `distance_from_line_atr` — the existing ATR-14 champion/prod
 *     comparison filter. Keep it visible so dashboard comparisons stay
 *     anchored to the current production setup.
 *   - `ema_50_5m_alignment` — kept registered as a stable head-to-head
 *     benchmark for the former production alignment signal and for any
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
  distanceFromLineAtr3Filter,
  distanceFromLineAtr4Filter,
  distanceFromLineAtrFilter,
  ema505mAlignmentFilter,
];
