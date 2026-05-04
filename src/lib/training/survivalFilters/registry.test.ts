import { survivalFilters } from "@alea/lib/training/survivalFilters/registry";
import { describe, expect, it } from "bun:test";

describe("survivalFilters", () => {
  it("registers exactly the active filter set: champion + live-trader benchmark", () => {
    expect(survivalFilters.map((filter) => filter.id)).toEqual([
      "distance_from_line_atr",
      "ema_50_5m_alignment",
    ]);
  });

  it("does not register duplicate ids", () => {
    const ids = survivalFilters.map((filter) => filter.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
