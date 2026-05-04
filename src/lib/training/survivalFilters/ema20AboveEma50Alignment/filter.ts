import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

/**
 * "Is the current side aligned with the EMA-20-vs-EMA-50 cross?"
 *
 * Adds 1st-derivative trend info on top of plain price-vs-EMA: even if
 * price is above the slow MA, the trend may already be turning down
 * (fast EMA dipping below slow EMA). The cross moves before
 * price-vs-MA flips, so this can lead the EMA-50 alignment signal.
 *
 *   - EMA20 ≥ EMA50 → bullish trend → UP is aligned, DOWN is against
 *   - EMA20  < EMA50 → bearish trend → DOWN is aligned, UP is against
 *
 * Constant across the window's four snapshots. Skipped until both EMAs
 * have warmed up.
 */
export const ema20AboveEma50AlignmentFilter: SurvivalFilter = {
  id: "ema_20_above_ema_50_alignment",
  displayName: "EMA-20 vs EMA-50 cross alignment",
  description:
    "Splits snapshots by whether the current side agrees with the EMA-20-above-EMA-50 trend regime at the start of the window.",
  trueLabel: "aligned with EMA20>EMA50",
  falseLabel: "against EMA20>EMA50",
  version: 1,
  classify: (snapshot, context) => {
    const fast = context.ema20x5m;
    const slow = context.ema50x5m;
    if (fast === null || slow === null) {
      return "skip";
    }
    const trend = fast >= slow ? "up" : "down";
    return trend === snapshot.currentSide;
  },
};
