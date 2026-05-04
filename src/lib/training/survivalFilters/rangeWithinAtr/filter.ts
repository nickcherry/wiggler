import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

const TIGHT_RANGE_THRESHOLD = 0.5;

/**
 * "Was the most recent COMPLETED 5m bar's range less than 0.5×
 * ATR-14 (a notably tight bar)?"
 *
 * Bar-level compression. Where `vol_compression` looks at the
 * regime-level (ATR ratios), this looks at the bar-level — a
 * single tight bar can mean indecision / coiling that often
 * resolves in the dominant direction. Sibling-test of the dropped
 * `range_expansion` (which looked at the opposite tail).
 */
export const rangeWithinAtrFilter: SurvivalFilter = {
  id: "range_within_atr",
  displayName: "Tight last bar (range < 0.5 ATR)",
  description:
    "Splits snapshots by whether the most recent 5m bar's range was less than half the trailing 14-bar ATR (a tight / coiled bar).",
  trueLabel: "tight last bar",
  falseLabel: "normal-or-wide bar",
  version: 1,
  classify: (_snapshot, context) => {
    const bar = context.prev5mBar;
    const atr = context.atr14x5m;
    if (bar === null || atr === null || atr === 0) {
      return "skip";
    }
    const range = bar.high - bar.low;
    return range < TIGHT_RANGE_THRESHOLD * atr;
  },
};
