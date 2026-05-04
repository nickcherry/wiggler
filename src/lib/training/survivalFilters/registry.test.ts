import { survivalFilters } from "@alea/lib/training/survivalFilters/registry";
import { describe, expect, it } from "bun:test";

describe("survivalFilters", () => {
  it("keeps the active dashboard filter set ordered and explicit", () => {
    expect(survivalFilters.map((filter) => filter.id)).toEqual([
      "ema_50_5m_alignment",
      "distance_from_line_atr",
      "roc_5_strong_aligned",
      "distance_atr_with_ema_aligned",
      "rsi_extreme_against_side",
      "vol_compression",
      "volume_high_aligned",
      "recent_breakout_aligned",
      "weekend_session",
      "utc_hour_us_session",
    ]);
  });

  it("does not register duplicate ids", () => {
    const ids = survivalFilters.map((filter) => filter.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
