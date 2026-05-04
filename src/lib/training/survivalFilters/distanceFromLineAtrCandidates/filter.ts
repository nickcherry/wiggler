import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

/**
 * Short-period variants of the distance-from-line ATR filter. The May
 * 2026 sweep found ATR-3 to be the strongest equal-asset average and
 * ATR-4 to be the near-tied per-asset comparator. These are dashboard
 * candidates only; the existing ATR-14 filter remains registered for
 * production comparison.
 */
export const distanceFromLineAtr3Filter: SurvivalFilter = {
  id: "distance_from_line_atr_3",
  displayName: "Distance from price line >= 0.5 ATR-3",
  description:
    "Has price moved at least half a very recent typical 5-min swing away from where the window opened? (ATR-3.)",
  trueLabel: ">= 0.5 ATR-3",
  falseLabel: "< 0.5 ATR-3",
  version: 1,
  classify: (snapshot, context) => {
    const atr = context.atr3x5m;
    if (atr === null || atr === 0) {
      return "skip";
    }
    return Math.abs(snapshot.snapshotPrice - snapshot.line) >= 0.5 * atr;
  },
};

export const distanceFromLineAtr4Filter: SurvivalFilter = {
  id: "distance_from_line_atr_4",
  displayName: "Distance from price line >= 0.5 ATR-4",
  description:
    "Has price moved at least half a short-run typical 5-min swing away from where the window opened? (ATR-4.)",
  trueLabel: ">= 0.5 ATR-4",
  falseLabel: "< 0.5 ATR-4",
  version: 1,
  classify: (snapshot, context) => {
    const atr = context.atr4x5m;
    if (atr === null || atr === 0) {
      return "skip";
    }
    return Math.abs(snapshot.snapshotPrice - snapshot.line) >= 0.5 * atr;
  },
};
