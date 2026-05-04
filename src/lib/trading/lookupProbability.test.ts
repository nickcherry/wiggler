import { lookupProbability } from "@alea/lib/trading/lookupProbability";
import type { ProbabilityTable } from "@alea/lib/trading/types";
import { describe, expect, it } from "bun:test";

const baseTable: ProbabilityTable = {
  command: "trading:gen-probability-table",
  schemaVersion: 1,
  generatedAtMs: 0,
  series: { source: "binance", product: "perp", timeframe: "5m" },
  minBucketSamples: 200,
  trainingRangeMs: { firstWindowMs: 0, lastWindowMs: 0 },
  assets: [
    {
      asset: "btc",
      windowCount: 1000,
      alignedWindowShare: 0.5,
      aligned: {
        byRemaining: {
          1: [
            { distanceBp: 1, samples: 500, probability: 0.95 },
            { distanceBp: 5, samples: 300, probability: 0.85 },
          ],
          2: [],
          3: [],
          4: [{ distanceBp: 1, samples: 1000, probability: 0.7 }],
        },
      },
      notAligned: {
        byRemaining: {
          1: [{ distanceBp: 1, samples: 200, probability: 0.6 }],
          2: [],
          3: [],
          4: [],
        },
      },
      sweetSpot: {
        startBp: 0,
        endBp: 100,
        calibrationScore: 0.01,
        coverageFraction: 0.5,
      },
    },
  ],
};

describe("lookupProbability", () => {
  it("returns the exact bucket for a hit", () => {
    const lookup = lookupProbability({
      table: baseTable,
      asset: "btc",
      aligned: true,
      remaining: 1,
      distanceBp: 5,
    });
    expect(lookup).toEqual({
      distanceBp: 5,
      probability: 0.85,
      samples: 300,
    });
  });

  it("returns null when the bucket is absent (gap or beyond-tail)", () => {
    expect(
      lookupProbability({
        table: baseTable,
        asset: "btc",
        aligned: true,
        remaining: 1,
        distanceBp: 3,
      }),
    ).toBeNull();
    expect(
      lookupProbability({
        table: baseTable,
        asset: "btc",
        aligned: true,
        remaining: 1,
        distanceBp: 99,
      }),
    ).toBeNull();
  });

  it("respects the alignment toggle", () => {
    const aligned = lookupProbability({
      table: baseTable,
      asset: "btc",
      aligned: true,
      remaining: 1,
      distanceBp: 1,
    });
    const notAligned = lookupProbability({
      table: baseTable,
      asset: "btc",
      aligned: false,
      remaining: 1,
      distanceBp: 1,
    });
    expect(aligned?.probability).toBe(0.95);
    expect(notAligned?.probability).toBe(0.6);
  });

  it("returns null for unknown assets", () => {
    expect(
      lookupProbability({
        table: baseTable,
        asset: "eth",
        aligned: true,
        remaining: 1,
        distanceBp: 1,
      }),
    ).toBeNull();
  });
});
