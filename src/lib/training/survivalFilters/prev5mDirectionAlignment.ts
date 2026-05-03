import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

/**
 * "Did the previous completed 5m candle agree with the side currently
 * leading?"
 *
 * Constant across all four snapshots in a window — the previous 5m bar's
 * direction doesn't change mid-window, only the current side does.
 *
 * Skipped: when the previous 5m candle isn't present in the loaded 5m
 * series (very first window of the backfill).
 */
export const prev5mDirectionAlignmentFilter: SurvivalFilter = {
  id: "prev_5m_direction_alignment",
  displayName: "Previous 5m candle alignment",
  description:
    "Splits snapshots by whether the prior 5m candle closed in the same direction as the current side.",
  trueLabel: "aligned with prev 5m",
  falseLabel: "against prev 5m",
  version: 1,
  classify: (snapshot, context) => {
    const prev = context.prev5mDirection;
    if (prev === null) {
      return "skip";
    }
    return prev === snapshot.currentSide;
  },
};
