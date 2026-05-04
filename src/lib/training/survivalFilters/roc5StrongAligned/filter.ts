import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

const STRONG_ROC_PCT = 0.25;

/**
 * "Is the 5-bar ROC magnitude ≥ 0.25%, AND is the current side
 * aligned with the ROC's direction?"
 *
 * Short-window cousin of `roc_20_strong_alignment` (a round-2
 * winner). Same threshold-gated momentum mechanism but with a much
 * shorter lookback (25 minutes vs 100 minutes), so the signal
 * fires more often and reflects fresher momentum. The lower
 * threshold (0.25% vs 0.5%) accounts for the shorter window
 * naturally having smaller swings.
 */
export const roc5StrongAlignedFilter: SurvivalFilter = {
  id: "roc_5_strong_aligned",
  displayName: "ROC-5 strong + aligned",
  description:
    "Splits snapshots where |ROC-5| ≥ 0.25% by whether the current side matches the ROC's direction.",
  trueLabel: "with strong ROC-5",
  falseLabel: "against strong ROC-5",
  version: 1,
  classify: (snapshot, context) => {
    const roc = context.roc5Pct;
    if (roc === null) {
      return "skip";
    }
    if (Math.abs(roc) < STRONG_ROC_PCT) {
      return "skip";
    }
    const bias: "up" | "down" = roc > 0 ? "up" : "down";
    return bias === snapshot.currentSide;
  },
};
