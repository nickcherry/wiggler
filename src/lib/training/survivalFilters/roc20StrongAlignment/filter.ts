import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

const STRONG_ROC_PCT = 0.5;

/**
 * "Is the 20-bar ROC magnitude ≥ 0.5%, AND is the current side
 * aligned with the ROC's direction?"
 *
 * Threshold-gated momentum-alignment: a sharper version of the
 * (dropped) plain `roc_20` filter, which split on direction alone.
 * The hypothesis: weak / near-zero ROC carries no usable signal;
 * STRONG positive or negative momentum may genuinely predict
 * continuation when the side agrees, or reversion when it doesn't.
 * Skip the weak-momentum middle so the score isn't diluted.
 */
export const roc20StrongAlignmentFilter: SurvivalFilter = {
  id: "roc_20_strong_alignment",
  displayName: "ROC-20 strong + aligned",
  description:
    "Splits snapshots where |ROC-20| ≥ 0.5% by whether the current side matches the ROC's direction.",
  trueLabel: "with strong ROC",
  falseLabel: "against strong ROC",
  version: 1,
  classify: (snapshot, context) => {
    const roc = context.roc20Pct;
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
