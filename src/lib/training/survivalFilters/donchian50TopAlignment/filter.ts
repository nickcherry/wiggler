import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

/**
 * "Is the current side aligned with where the line price sits in its
 * 50-bar Donchian (high/low) range?"
 *
 * Range-based trend signal. Position ≥ 50% means line is in the upper
 * half of the recent 50-bar range — a "near-the-highs" regime — and
 * UP-side snapshots are aligned. Different mechanism than MA-based
 * filters: a price chopping at the top of a range can have line >
 * Donchian midpoint but still be near a moving average.
 *
 * Skipped when the 50-bar range is degenerate (high == low).
 */
export const donchian50TopAlignmentFilter: SurvivalFilter = {
  id: "donchian_50_top_alignment",
  displayName: "Donchian-50 position alignment",
  description:
    "Splits snapshots by whether the current side agrees with which half of the 50-bar high/low range the line price sits in.",
  trueLabel: "aligned with Donchian top half",
  falseLabel: "against Donchian top half",
  version: 1,
  classify: (snapshot, context) => {
    const high = context.donchian50High;
    const low = context.donchian50Low;
    if (high === null || low === null) {
      return "skip";
    }
    const range = high - low;
    if (range <= 0) {
      return "skip";
    }
    const position = (snapshot.line - low) / range;
    const half = position >= 0.5 ? "up" : "down";
    return half === snapshot.currentSide;
  },
};
