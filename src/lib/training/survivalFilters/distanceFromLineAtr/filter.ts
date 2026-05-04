import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

/**
 * "Has the snapshot price moved at least 0.5 ATR-14 away from the
 * line?"
 *
 * Proximity-to-line risk: snapshots that haven't yet decisively
 * separated from the line are intuitively the most flip-prone — a
 * smaller move can switch sides. The filter splits those "decisively
 * separated" snapshots from the rest. We don't skip the close ones
 * (we want to see the contrast), only skip when ATR is unavailable.
 */
export const distanceFromLineAtrFilter: SurvivalFilter = {
  id: "distance_from_line_atr",
  displayName: "Distance from price line ≥ 0.5 ATR",
  description:
    "Has price decisively pulled away from where the window opened? (At least half a typical 5-min swing away.)",
  trueLabel: "decisively away",
  falseLabel: "near the line",
  version: 1,
  classify: (snapshot, context) => {
    const atr = context.atr14x5m;
    if (atr === null || atr === 0) {
      return "skip";
    }
    return Math.abs(snapshot.snapshotPrice - snapshot.line) >= 0.5 * atr;
  },
};
