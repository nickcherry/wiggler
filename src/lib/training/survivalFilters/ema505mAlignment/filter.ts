import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

/**
 * "Is the current side aligned with the 50-period 5m EMA regime?"
 *
 * Longer-window cousin of `ema_20_5m_alignment`: more lag, less noise,
 * captures slower regime shifts. Same comparison: line price (open of
 * the current 5m window) vs the EMA-50 evaluated *just before* the
 * window starts.
 *
 *   - line ≥ EMA50 → bullish regime → UP is aligned, DOWN is against
 *   - line  < EMA50 → bearish regime → DOWN is aligned, UP is against
 *
 * Constant across all four snapshots in a window. Skipped until the EMA
 * has its 50-bar warm-up.
 */
export const ema505mAlignmentFilter: SurvivalFilter = {
  id: "ema_50_5m_alignment",
  displayName: "50-period 5m EMA alignment",
  description:
    "Splits snapshots by whether the current side agrees with the line-vs-EMA50 regime at the start of the window.",
  trueLabel: "aligned with EMA50",
  falseLabel: "against EMA50",
  version: 1,
  classify: (snapshot, context) => {
    const ema = context.ema50x5m;
    if (ema === null) {
      return "skip";
    }
    const regime = snapshot.line >= ema ? "up" : "down";
    return regime === snapshot.currentSide;
  },
};
