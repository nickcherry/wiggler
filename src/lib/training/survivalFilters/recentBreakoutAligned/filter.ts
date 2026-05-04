import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

const RECENT_BARS_THRESHOLD = 5;

/**
 * "Did the 50-bar high (or low) print in the last 5 bars, AND is
 * the current side aligned with that extreme's direction?"
 *
 * Recent-breakout test. A fresh 50-bar high in the last few bars
 * with side=up means we're trading just after a breakout in the
 * side's direction; the symmetric condition for the low + side=
 * down. Older `donchian_extreme_alignment` looked at price-near-
 * extreme in space; this looks at price-near-extreme in TIME, a
 * very different mechanism.
 */
export const recentBreakoutAlignedFilter: SurvivalFilter = {
  id: "recent_breakout_aligned",
  displayName: "Fresh 50-bar extreme + aligned",
  description:
    "Splits snapshots by whether the 50-bar high (or low) printed within the last 5 completed 5m bars AND the current side matches that extreme's direction.",
  trueLabel: "fresh breakout + aligned",
  falseLabel: "no fresh breakout / against",
  version: 1,
  classify: (snapshot, context) => {
    const sinceHigh = context.bars5mSinceDonchian50High;
    const sinceLow = context.bars5mSinceDonchian50Low;
    if (sinceHigh === null || sinceLow === null) {
      return "skip";
    }
    const recentHigh = sinceHigh <= RECENT_BARS_THRESHOLD;
    const recentLow = sinceLow <= RECENT_BARS_THRESHOLD;
    if (recentHigh && !recentLow) {
      return snapshot.currentSide === "up";
    }
    if (recentLow && !recentHigh) {
      return snapshot.currentSide === "down";
    }
    // Both recent (rare — small range) or neither recent: skip,
    // the extreme isn't carrying directional information here.
    return "skip";
  },
};
