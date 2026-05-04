import { survivalFilters } from "@alea/lib/training/survivalFilters/registry";
import { describe, expect, it } from "bun:test";

describe("survivalFilters", () => {
  it("registers exactly the active dashboard candidate set", () => {
    expect(survivalFilters.map((filter) => filter.id)).toEqual([
      "distance_from_line_atr_3",
      "distance_from_line_atr_4",
      "distance_from_line_atr",
      "ema_50_5m_alignment",
    ]);
  });

  it("does not register duplicate ids", () => {
    const ids = survivalFilters.map((filter) => filter.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
