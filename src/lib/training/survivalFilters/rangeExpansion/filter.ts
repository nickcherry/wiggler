import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

/**
 * "Did the most recent COMPLETED 5m bar print an unusually large
 * range (≥ 1.5× the trailing ATR-14)?"
 *
 * Pure volatility-event filter. Doesn't ask about direction at all —
 * splits snapshots into "we just had a vol spike" vs "we didn't". The
 * hypothesis: sides taken in the wake of a vol expansion behave
 * differently than sides taken in a quiet stretch (could go either
 * way: spikes might predict reversal, or could predict continuation
 * — the data tells us).
 */
export const rangeExpansionFilter: SurvivalFilter = {
  id: "range_expansion",
  displayName: "Range expansion (last bar > 1.5× ATR)",
  description:
    "Splits snapshots by whether the most recent 5m bar's range exceeded 1.5× the trailing 14-bar ATR.",
  trueLabel: "after range expansion",
  falseLabel: "no range expansion",
  version: 1,
  classify: (_snapshot, context) => {
    const bar = context.prev5mBar;
    const atr = context.atr14x5m;
    if (bar === null || atr === null || atr === 0) {
      return "skip";
    }
    const range = bar.high - bar.low;
    return range >= 1.5 * atr;
  },
};
