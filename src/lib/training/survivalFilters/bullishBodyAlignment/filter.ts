import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

/**
 * "Did the most recent COMPLETED 5m bar close decisively in the
 * direction of the current side?"
 *
 * "Decisively" = the bar's body is at least 60% of its full
 * high-low range, and the bar closed in the same direction as the
 * snapshot's current side. Bar-shape signal — orthogonal to MA-based
 * trend filters. The hypothesis: a single fresh decisive bar is
 * predictive even after smoothed-trend filters disagree.
 *
 * Snapshots where the prior bar wasn't decisive (small body, doji,
 * long-wick rejection) are skipped — this filter only fires on
 * "momentum bar just printed" windows.
 */
export const bullishBodyAlignmentFilter: SurvivalFilter = {
  id: "bullish_body_alignment",
  displayName: "Decisive-bar alignment",
  description:
    "Filters snapshots where the prior 5m bar had body ≥ 60% of its range, then splits by whether the bar's direction matches the current side.",
  trueLabel: "aligned with decisive bar",
  falseLabel: "against decisive bar",
  version: 1,
  classify: (snapshot, context) => {
    const bar = context.prev5mBar;
    if (bar === null) {
      return "skip";
    }
    const range = bar.high - bar.low;
    if (range <= 0) {
      return "skip";
    }
    const body = Math.abs(bar.close - bar.open);
    const bodyRatio = body / range;
    if (bodyRatio < 0.6) {
      return "skip";
    }
    const direction = bar.close >= bar.open ? "up" : "down";
    return direction === snapshot.currentSide;
  },
};
