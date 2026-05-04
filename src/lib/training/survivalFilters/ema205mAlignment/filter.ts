import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

/**
 * "Is the current side aligned with the 20-period 5m EMA regime?"
 *
 * Like `ma_20_5m_alignment` but with the exponential moving average,
 * which weights recent bars more heavily than the simple average. The
 * EMA tends to flip regime faster than the SMA on real moves and lag
 * less on sustained trends — useful as a trend-vs-mean-reversion
 * comparison against the SMA-20 filter.
 *
 *   - line ≥ EMA20 → bullish regime → UP is aligned, DOWN is against
 *   - line  < EMA20 → bearish regime → DOWN is aligned, UP is against
 *
 * Constant across all four snapshots in a window. Skipped until the EMA
 * has its 20-bar warm-up.
 */
export const ema205mAlignmentFilter: SurvivalFilter = {
  id: "ema_20_5m_alignment",
  displayName: "20-period 5m EMA alignment",
  description:
    "Splits snapshots by whether the current side agrees with the line-vs-EMA20 regime at the start of the window.",
  trueLabel: "aligned with EMA20",
  falseLabel: "against EMA20",
  version: 1,
  classify: (snapshot, context) => {
    const ema = context.ema20x5m;
    if (ema === null) {
      return "skip";
    }
    const regime = snapshot.line >= ema ? "up" : "down";
    return regime === snapshot.currentSide;
  },
};
