import {
  computeAllPercentiles,
  computePercentile,
} from "@wiggler/lib/training/computePercentiles";
import { describe, expect, it } from "bun:test";

describe("computePercentile", () => {
  it("returns the only value for a single-element array", () => {
    expect(computePercentile({ sortedValues: [7], p: 0 })).toBe(7);
    expect(computePercentile({ sortedValues: [7], p: 50 })).toBe(7);
    expect(computePercentile({ sortedValues: [7], p: 100 })).toBe(7);
  });

  it("returns endpoints for p=0 and p=100", () => {
    const v = [1, 2, 3, 4, 5];
    expect(computePercentile({ sortedValues: v, p: 0 })).toBe(1);
    expect(computePercentile({ sortedValues: v, p: 100 })).toBe(5);
  });

  it("returns the median for p=50 on odd-length arrays", () => {
    const v = [1, 2, 3, 4, 5];
    expect(computePercentile({ sortedValues: v, p: 50 })).toBe(3);
  });

  it("linearly interpolates between samples for p=50 on even-length arrays", () => {
    const v = [1, 2, 3, 4];
    expect(computePercentile({ sortedValues: v, p: 50 })).toBe(2.5);
  });

  it("matches numpy linear interpolation on a known example", () => {
    // numpy.percentile([0, 100], 25, interpolation="linear") == 25
    expect(computePercentile({ sortedValues: [0, 100], p: 25 })).toBe(25);
    expect(computePercentile({ sortedValues: [0, 100], p: 75 })).toBe(75);
  });

  it("throws on empty input", () => {
    expect(() => computePercentile({ sortedValues: [], p: 50 })).toThrow();
  });

  it("throws on out-of-range p", () => {
    expect(() => computePercentile({ sortedValues: [1, 2], p: -1 })).toThrow();
    expect(() => computePercentile({ sortedValues: [1, 2], p: 101 })).toThrow();
  });
});

describe("computeAllPercentiles", () => {
  it("returns a length-101 array", () => {
    const out = computeAllPercentiles({ sortedValues: [1, 2, 3] });
    expect(out).toHaveLength(101);
  });

  it("produces a non-decreasing sequence", () => {
    const out = computeAllPercentiles({
      sortedValues: [0.1, 0.2, 0.5, 1.0, 2.0, 5.0, 10.0],
    });
    for (let p = 1; p <= 100; p += 1) {
      const prev = out[p - 1];
      const curr = out[p];
      if (prev === undefined || curr === undefined) {
        throw new Error("unexpected undefined");
      }
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
  });

  it("anchors p=0 to the min and p=100 to the max", () => {
    const sorted = [1, 4, 9, 16, 25];
    const out = computeAllPercentiles({ sortedValues: sorted });
    expect(out[0]).toBe(1);
    expect(out[100]).toBe(25);
  });
});
