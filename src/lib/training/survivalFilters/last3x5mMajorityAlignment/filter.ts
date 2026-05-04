import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

/**
 * "Does the recent 5m micro-trend (majority direction of the last three
 * completed 5m bars) agree with the side currently leading?"
 *
 * The "majority direction" is whichever of UP/DOWN appears at least
 * twice among the three most recent completed 5m bars before the
 * current 5m window. Three equal directions count as that direction;
 * 2-1 splits resolve to the majority. (No tie case exists with three
 * binary candles.) Constant across the window's four snapshots.
 *
 * Skipped when fewer than three preceding 5m bars are present in the
 * loaded series.
 */
export const last3x5mMajorityAlignmentFilter: SurvivalFilter = {
  id: "last_3_5m_majority_alignment",
  displayName: "Last 3 5m candles majority alignment",
  description:
    "Splits snapshots by whether the majority direction of the previous three 5m candles matches the current side.",
  trueLabel: "aligned with last-3 majority",
  falseLabel: "against last-3 majority",
  version: 1,
  classify: (snapshot, context) => {
    const last3 = context.last3x5mDirections;
    if (last3 === null) {
      return "skip";
    }
    const ups = last3.filter((d) => d === "up").length;
    const majority = ups >= 2 ? "up" : "down";
    return majority === snapshot.currentSide;
  },
};
