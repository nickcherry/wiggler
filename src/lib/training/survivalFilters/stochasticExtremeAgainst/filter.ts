import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

const OVERBOUGHT = 80;
const OVERSOLD = 20;

/**
 * "Is the 14-period stochastic %K in extreme territory (≥80 or ≤20)
 * AND does the current side bet on mean reversion?"
 *
 * Stochastic counterpart to `rsi_extreme_against_side`. Where RSI
 * weighs gains vs losses (Wilder smoothing), stochastic measures
 * close-position within the recent high-low range — they often
 * agree but disagree at the edges (e.g., a market grinding higher
 * with shallow pullbacks shows high RSI but mid-range stochastic).
 * Worth its own A/B because the disagreement is where the alpha is.
 */
export const stochasticExtremeAgainstFilter: SurvivalFilter = {
  id: "stochastic_extreme_against",
  displayName: "Stochastic extreme + side opposes",
  description:
    "Splits snapshots where stochastic %K (14) is ≥80 or ≤20 by whether the current side bets on mean reversion (down at overbought, up at oversold).",
  trueLabel: "fading the extreme",
  falseLabel: "with the extreme",
  version: 1,
  classify: (snapshot, context) => {
    const k = context.stoch14x5m;
    if (k === null) {
      return "skip";
    }
    if (k >= OVERBOUGHT) {
      return snapshot.currentSide === "down";
    }
    if (k <= OVERSOLD) {
      return snapshot.currentSide === "up";
    }
    return "skip";
  },
};
