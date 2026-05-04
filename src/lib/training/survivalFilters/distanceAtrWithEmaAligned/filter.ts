import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

const DISTANCE_THRESHOLD_ATR = 0.5;

/**
 * "Has the snapshot price moved at least 0.5 ATR-14 away from the
 * line AND is the current side aligned with the EMA-50 trend?"
 *
 * Compound of two consistent winners — `distance_from_line_atr`
 * (decisive displacement) and `ema_50_5m_alignment` (trend
 * direction). Earlier compound experiments diluted, but those
 * combined two filters whose populations heavily overlapped. This
 * one combines proximity (purely positional) with trend (purely
 * directional), so the two should be more orthogonal.
 *
 * Skip semantics: false is only meaningful when both pieces of
 * context are present; missing either skips.
 */
export const distanceAtrWithEmaAlignedFilter: SurvivalFilter = {
  id: "distance_atr_with_ema_aligned",
  displayName: "Decisively away AND EMA-50 aligned",
  description:
    "Is price both decisively away from the window's open AND riding the longer-term trend?",
  trueLabel: "decisive + trend-aligned",
  falseLabel: "either condition fails",
  version: 1,
  classify: (snapshot, context) => {
    const atr = context.atr14x5m;
    const ema = context.ema50x5m;
    if (atr === null || atr === 0 || ema === null) {
      return "skip";
    }
    const decisive =
      Math.abs(snapshot.snapshotPrice - snapshot.line) >=
      DISTANCE_THRESHOLD_ATR * atr;
    const emaBias: "up" | "down" = snapshot.line >= ema ? "up" : "down";
    const aligned = emaBias === snapshot.currentSide;
    return decisive && aligned;
  },
};
