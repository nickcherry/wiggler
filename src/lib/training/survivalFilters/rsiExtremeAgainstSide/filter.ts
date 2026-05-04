import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

const OVERBOUGHT = 70;
const OVERSOLD = 30;

/**
 * "Is the RSI in extreme territory (≥70 or ≤30) AND does the
 * current side point AGAINST that extreme?"
 *
 * Mean-reversion test at the momentum extremes. Snapshots with
 * RSI ≥ 70 + side=DOWN are betting the overbought reading mean-
 * reverts; RSI ≤ 30 + side=UP is the symmetric oversold-bounce bet.
 * The filter splits those reversion-aligned snapshots from the rest;
 * only the extreme-RSI subset is classified at all (mid-range is
 * skipped since neither overbought nor oversold).
 *
 * Different from `rsi_14_5m_alignment` (which is direction-only at
 * the 50 midpoint) — this one only fires in the tails and asks the
 * opposite question.
 */
export const rsiExtremeAgainstSideFilter: SurvivalFilter = {
  id: "rsi_extreme_against_side",
  displayName: "RSI extreme + side opposes",
  description:
    "At an overbought (RSI ≥ 70) or oversold (≤ 30) extreme, is the leading side betting on a reversal?",
  trueLabel: "fading the extreme",
  falseLabel: "with the extreme",
  version: 1,
  classify: (snapshot, context) => {
    const rsi = context.rsi14x5m;
    if (rsi === null) {
      return "skip";
    }
    if (rsi >= OVERBOUGHT) {
      return snapshot.currentSide === "down";
    }
    if (rsi <= OVERSOLD) {
      return snapshot.currentSide === "up";
    }
    return "skip";
  },
};
