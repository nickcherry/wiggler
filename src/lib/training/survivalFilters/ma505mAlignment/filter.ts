import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

/**
 * "Is the current side aligned with the 50-period 5m moving-average
 * regime?"
 *
 * Same idea as `ma_20_5m_alignment` but with a longer SMA, capturing a
 * slower trend reference (~4 hours of 5m bars). Compares the line price
 * (open of the current 5m window) to the SMA-50 evaluated *just before*
 * the window starts:
 *
 *   - line ≥ MA50 → bullish regime → UP is aligned, DOWN is against
 *   - line  < MA50 → bearish regime → DOWN is aligned, UP is against
 *
 * Constant across all four snapshots in a window. Skipped when fewer
 * than 50 prior 5m closes are available.
 */
export const ma505mAlignmentFilter: SurvivalFilter = {
  id: "ma_50_5m_alignment",
  displayName: "50-period 5m MA alignment",
  description:
    "Splits snapshots by whether the current side agrees with the line-vs-MA50 regime at the start of the window.",
  trueLabel: "aligned with MA50",
  falseLabel: "against MA50",
  version: 1,
  classify: (snapshot, context) => {
    const ma = context.ma50x5m;
    if (ma === null) {
      return "skip";
    }
    const regime = snapshot.line >= ma ? "up" : "down";
    return regime === snapshot.currentSide;
  },
};
