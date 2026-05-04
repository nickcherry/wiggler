import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

/**
 * "Is the current side aligned with the RSI-14 momentum bias?"
 *
 * Classical momentum oscillator: RSI ≥ 50 means the recent average
 * gain has outweighed the average loss (Wilder smoothing over 14 5m
 * bars). Different normalization than price-vs-EMA, so even though
 * both speak to "trend direction" they can disagree at boundaries.
 */
export const rsi145mAlignmentFilter: SurvivalFilter = {
  id: "rsi_14_5m_alignment",
  displayName: "RSI-14 alignment",
  description:
    "Splits snapshots by whether the current side agrees with the RSI-14 momentum direction (RSI ≥ 50 = bullish).",
  trueLabel: "aligned with RSI14",
  falseLabel: "against RSI14",
  version: 1,
  classify: (snapshot, context) => {
    const rsi = context.rsi14x5m;
    if (rsi === null) {
      return "skip";
    }
    const bias = rsi >= 50 ? "up" : "down";
    return bias === snapshot.currentSide;
  },
};
