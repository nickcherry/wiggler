import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

/**
 * "Are we in a low-volatility regime (ATR-14 below ATR-50)?"
 *
 * Vol regime filter, fully orthogonal to trend. The hypothesis: in
 * compressed-volatility windows the in-window price tends to maintain
 * direction better — less random noise to flip the side back. In
 * expanded-vol windows the side is more likely to whipsaw before the
 * 5m close.
 */
export const volCompressionFilter: SurvivalFilter = {
  id: "vol_compression",
  displayName: "Volatility compression (ATR14 < ATR50)",
  description:
    "Splits snapshots by whether short-term realized volatility (ATR-14) is below the longer-term reference (ATR-50).",
  trueLabel: "compressed vol",
  falseLabel: "expanded vol",
  version: 1,
  classify: (_snapshot, context) => {
    const atr14 = context.atr14x5m;
    const atr50 = context.atr50x5m;
    if (atr14 === null || atr50 === null) {
      return "skip";
    }
    return atr14 < atr50;
  },
};
