import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

/**
 * "Does the very recent micro-trend (last three 1m candles) agree with
 * the side currently leading?"
 *
 * The "majority direction" is whichever of UP/DOWN appears at least twice
 * among the three candles immediately before the snapshot's 1m candle.
 * Three equal directions count as that direction; 2-1 splits resolve to
 * the majority. (No tie case exists with three binary candles.)
 *
 * Skipped when fewer than three preceding 1m candles are present in the
 * loaded series.
 */
export const last3x1mMajorityAlignmentFilter: SurvivalFilter = {
  id: "last_3_1m_majority_alignment",
  displayName: "Last 3 1m candles majority alignment",
  description:
    "Splits snapshots by whether the majority direction of the previous three 1m candles matches the current side.",
  trueLabel: "aligned with last-3 majority",
  falseLabel: "against last-3 majority",
  classify: (snapshot, context) => {
    const last3 = context.last3x1mDirections;
    if (last3 === null) {
      return "skip";
    }
    const ups = last3.filter((d) => d === "up").length;
    const majority = ups >= 2 ? "up" : "down";
    return majority === snapshot.currentSide;
  },
};
