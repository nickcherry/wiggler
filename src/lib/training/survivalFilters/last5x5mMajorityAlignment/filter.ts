import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

/**
 * "Does the recent 5m micro-trend (majority direction of the last five
 * completed 5m bars) agree with the side currently leading?"
 *
 * Majority direction = whichever of UP/DOWN appears at least three
 * times among the five most recent completed 5m bars before the
 * current 5m window. (No tie case exists with five binary candles.)
 * Constant across the window's four snapshots.
 *
 * Skipped when fewer than five preceding 5m bars are present in the
 * loaded series.
 */
export const last5x5mMajorityAlignmentFilter: SurvivalFilter = {
  id: "last_5_5m_majority_alignment",
  displayName: "Last 5 5m candles majority alignment",
  description:
    "Splits snapshots by whether the majority direction of the previous five 5m candles matches the current side.",
  trueLabel: "aligned with last-5 majority",
  falseLabel: "against last-5 majority",
  version: 1,
  classify: (snapshot, context) => {
    const last5 = context.last5x5mDirections;
    if (last5 === null) {
      return "skip";
    }
    const ups = last5.filter((d) => d === "up").length;
    const majority = ups >= 3 ? "up" : "down";
    return majority === snapshot.currentSide;
  },
};
