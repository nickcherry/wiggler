import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

/**
 * "Did the previous 1m candle agree with the side currently leading?"
 *
 * Aligned (true): the 1m candle just before the snapshot's 1m candle
 * closed in the same direction as the snapshot's current side. So if the
 * previous 1m was green/up and the current side is UP, that's aligned.
 *
 * Skipped: when the snapshot is at the very start of the series and the
 * previous 1m candle isn't loaded.
 */
export const prev1mDirectionAlignmentFilter: SurvivalFilter = {
  id: "prev_1m_direction_alignment",
  displayName: "Previous 1m candle alignment",
  description:
    "Splits snapshots by whether the prior 1m candle closed in the same direction as the current side.",
  trueLabel: "aligned with prev 1m",
  falseLabel: "against prev 1m",
  classify: (snapshot, context) => {
    const prev = context.prev1mDirection;
    if (prev === null) {
      return "skip";
    }
    return prev === snapshot.currentSide;
  },
};
