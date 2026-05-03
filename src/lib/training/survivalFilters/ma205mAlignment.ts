import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

/**
 * "Is the current side aligned with the 20-period 5m moving-average
 * regime?"
 *
 * The MA-20 acts as a coarse trend reference. We compare the line price
 * (open of the current 5m window) to the MA evaluated *just before* the
 * window starts:
 *
 *   - line >= MA → bullish regime → UP is aligned, DOWN is against
 *   - line  < MA → bearish regime → DOWN is aligned, UP is against
 *
 * Constant across all four snapshots in a window. Skipped when fewer than
 * 20 prior 5m closes are available, or when the 5m series wasn't passed
 * to the snapshot enumerator at all.
 */
export const ma205mAlignmentFilter: SurvivalFilter = {
  id: "ma_20_5m_alignment",
  displayName: "20-period 5m MA alignment",
  description:
    "Splits snapshots by whether the current side agrees with the line-vs-MA20 regime at the start of the window.",
  trueLabel: "aligned with MA20",
  falseLabel: "against MA20",
  classify: (snapshot, context) => {
    const ma = context.ma20x5m;
    if (ma === null) {
      return "skip";
    }
    const regime = snapshot.line >= ma ? "up" : "down";
    return regime === snapshot.currentSide;
  },
};
