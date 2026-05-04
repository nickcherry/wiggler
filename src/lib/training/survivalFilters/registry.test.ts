import { survivalFilters } from "@alea/lib/training/survivalFilters/registry";
import { describe, expect, it } from "bun:test";

describe("survivalFilters", () => {
  it("registers the broadened evaluation set: active 10 + 5 unregistered + 13 restored", () => {
    expect(survivalFilters.map((filter) => filter.id)).toEqual([
      // Active dashboard filters
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
      // Unregistered 5m-trend cousins
      "ema_20_5m_alignment",
      "ma_20_5m_alignment",
      "ma_50_5m_alignment",
      "last_3_5m_majority_alignment",
      "last_5_5m_majority_alignment",
      // Restored from prune commits
      "bullish_body_alignment",
      "donchian_50_top_alignment",
      "ema_20_above_ema_50_alignment",
      "ema_50_slope_alignment",
      "european_session",
      "prev_5m_direction_alignment",
      "range_expansion",
      "range_within_atr",
      "roc_20_5m_alignment",
      "roc_20_strong_alignment",
      "rsi_14_5m_alignment",
      "stochastic_extreme_against",
      "stretched_from_ema_50_alignment",
    ]);
  });

  it("does not register duplicate ids", () => {
    const ids = survivalFilters.map((filter) => filter.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
