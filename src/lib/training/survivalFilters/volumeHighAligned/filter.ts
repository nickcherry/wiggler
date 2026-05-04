import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

const VOLUME_SPIKE_RATIO = 1.5;

/**
 * "Did the most recent COMPLETED 5m bar print volume ≥ 1.5× the
 * trailing 50-bar average AND did the bar's direction match the
 * snapshot's current side?"
 *
 * Volume-confirmation continuation hypothesis. A high-volume bar
 * in the side's direction means real flow agrees with the move —
 * institutional participation rather than thin retail. Tests
 * whether snapshots taken right after a "real" volume bar in
 * their direction hold side better than those after low-conviction
 * bars or volume bars going the other way. Sibling-tests
 * `volume_high_against_side` and `volume_low`.
 */
export const volumeHighAlignedFilter: SurvivalFilter = {
  id: "volume_high_aligned",
  displayName: "Volume spike + bar aligned with side",
  description:
    "Did the last 5-min bar print on heavy volume (≥ 1.5× recent average) and close in the leading side's direction?",
  trueLabel: "vol-confirmed continuation",
  falseLabel: "no spike or against",
  version: 1,
  classify: (snapshot, context) => {
    const v = context.prev5mBarVolume;
    const avg = context.avgVolume50x5m;
    const bar = context.prev5mBar;
    if (v === null || avg === null || avg === 0 || bar === null) {
      return "skip";
    }
    if (v < VOLUME_SPIKE_RATIO * avg) {
      return false;
    }
    const barDir: "up" | "down" = bar.close >= bar.open ? "up" : "down";
    return barDir === snapshot.currentSide;
  },
};
