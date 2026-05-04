import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

/**
 * "Is the current side aligned with the 100-minute (20 × 5m) rate of
 * change?"
 *
 * Pure directional momentum: positive ROC = price closed higher than
 * 20 bars ago, regardless of where it sits relative to a moving
 * average. Lighter-touch trend signal than EMA alignment.
 */
export const roc205mAlignmentFilter: SurvivalFilter = {
  id: "roc_20_5m_alignment",
  displayName: "ROC-20 alignment",
  description:
    "Splits snapshots by whether the current side agrees with the sign of the 20-bar (100m) rate of change.",
  trueLabel: "aligned with ROC20",
  falseLabel: "against ROC20",
  version: 1,
  classify: (snapshot, context) => {
    const roc = context.roc20Pct;
    if (roc === null) {
      return "skip";
    }
    if (roc === 0) {
      return "skip";
    }
    const direction = roc > 0 ? "up" : "down";
    return direction === snapshot.currentSide;
  },
};
