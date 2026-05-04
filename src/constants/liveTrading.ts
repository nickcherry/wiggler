import { distanceFromLineAtr3Filter } from "@alea/lib/training/survivalFilters/distanceFromLineAtrCandidates/filter";
import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

/**
 * Single source of truth for "which filter is currently powering live
 * trading". Read by:
 *
 *   - `computeAssetProbabilities` (training/genProbabilityTable) to
 *     classify historical snapshots into the `aligned` /
 *     `notAligned` surfaces persisted in the probability table.
 *   - `fiveMinuteAtrTracker` to seed/run live Wilder ATR with the
 *     same period the training-side filter uses.
 *   - `renderTrainingDistributionsHtml` to label which filter section
 *     gets the LIVE badge.
 *
 * Switching live to a different filter means changing this constant
 * and the matching `LIVE_TRADING_ATR_PERIOD` below, then regenerating
 * the probability table. No other call-site needs to know.
 */
export const LIVE_TRADING_FILTER: SurvivalFilter = distanceFromLineAtr3Filter;

/**
 * Period for the live Wilder ATR tracker. MUST match the period the
 * `LIVE_TRADING_FILTER` reads from `SurvivalSnapshotContext`
 * (e.g. ATR-3 → `context.atr3x5m`). The pair is co-located here so
 * promoting a different ATR-period filter is a single-file change.
 */
export const LIVE_TRADING_ATR_PERIOD = 3;
