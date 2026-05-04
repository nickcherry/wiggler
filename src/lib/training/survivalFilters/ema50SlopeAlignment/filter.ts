import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

/**
 * "Is the current side aligned with the direction the EMA-50 itself
 * is moving?"
 *
 * Pure trend-derivative signal — independent of where the line price
 * sits. A trend can be flat (price hovering near the MA) but with the
 * MA itself rising or falling; this catches that. Decoupled from the
 * EMA-50 alignment filter (which only reads position).
 *
 *   - EMA50 rising over the last 10 bars → UP aligned
 *   - EMA50 falling over the last 10 bars → DOWN aligned
 *   - exactly flat → skip
 */
export const ema50SlopeAlignmentFilter: SurvivalFilter = {
  id: "ema_50_slope_alignment",
  displayName: "EMA-50 slope alignment",
  description:
    "Splits snapshots by whether the current side agrees with the direction the EMA-50 has been moving over the last 10 5m bars.",
  trueLabel: "aligned with EMA50 slope",
  falseLabel: "against EMA50 slope",
  version: 1,
  classify: (snapshot, context) => {
    const slope = context.ema50SlopePct;
    if (slope === null) {
      return "skip";
    }
    if (slope === 0) {
      return "skip";
    }
    const direction = slope > 0 ? "up" : "down";
    return direction === snapshot.currentSide;
  },
};
