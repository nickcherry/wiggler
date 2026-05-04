import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

/**
 * "When line price is stretched far from EMA-50, is the current side
 * aligned with the direction of stretch?"
 *
 * Mean-reversion candidate. We only classify snapshots where the line
 * price is at least 1 ATR_14 away from the EMA-50 — when price is
 * extended, the question becomes "is current price holding the same
 * side as the extension?". A negative score (the "with-stretch" half
 * underperforms baseline) would be the mean-reversion signal: when
 * stretched UP, UP snapshots flip back to DOWN more often.
 *
 * Snapshots where price is *not* stretched are skipped, so this filter
 * only carries signal in the tail of the price-distance distribution.
 */
export const stretchedFromEma50AlignmentFilter: SurvivalFilter = {
  id: "stretched_from_ema_50_alignment",
  displayName: "Stretched-from-EMA-50 alignment",
  description:
    "Splits stretched snapshots (line ≥ 1 ATR-14 from EMA-50) by whether the current side matches the direction of stretch — tests for mean reversion.",
  trueLabel: "with the stretch",
  falseLabel: "against the stretch",
  version: 1,
  classify: (snapshot, context) => {
    const ema = context.ema50x5m;
    const atr = context.atr14x5m;
    if (ema === null || atr === null || atr === 0) {
      return "skip";
    }
    const stretch = snapshot.line - ema;
    if (Math.abs(stretch) < atr) {
      return "skip";
    }
    const stretchDirection = stretch > 0 ? "up" : "down";
    return stretchDirection === snapshot.currentSide;
  },
};
