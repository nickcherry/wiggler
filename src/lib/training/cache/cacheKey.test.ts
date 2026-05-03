import { cacheKeyFor } from "@alea/lib/training/cache/cacheKey";
import type {
  SizeDistributionCacheManifest,
  SurvivalFilterCacheManifest,
} from "@alea/lib/training/cache/cacheManifests";
import { describe, expect, it } from "bun:test";

const series = { source: "binance", product: "perp", timeframe: "5m" } as const;

describe("cacheKeyFor", () => {
  it("is deterministic for the same manifest", () => {
    const m: SizeDistributionCacheManifest = {
      kind: "size",
      series,
      asset: "btc",
      lastCandleMs5m: 1_700_000_000_000,
      algoVersion: 1,
    };
    expect(cacheKeyFor({ manifest: m })).toBe(cacheKeyFor({ manifest: m }));
  });

  it("ignores key order in serialized manifests", () => {
    const a: SizeDistributionCacheManifest = {
      kind: "size",
      series,
      asset: "btc",
      lastCandleMs5m: 1,
      algoVersion: 1,
    };
    const b: SizeDistributionCacheManifest = {
      algoVersion: 1,
      lastCandleMs5m: 1,
      asset: "btc",
      series,
      kind: "size",
    };
    expect(cacheKeyFor({ manifest: a })).toBe(cacheKeyFor({ manifest: b }));
  });

  it("changes when any field changes", () => {
    const base: SurvivalFilterCacheManifest = {
      kind: "filter",
      series,
      asset: "btc",
      lastCandleMs1m: 1,
      lastCandleMs5m: 1,
      pipelineVersion: 1,
      filterId: "x",
      filterVersion: 1,
    };
    const baseKey = cacheKeyFor({ manifest: base });
    expect(cacheKeyFor({ manifest: { ...base, asset: "eth" } })).not.toBe(
      baseKey,
    );
    expect(cacheKeyFor({ manifest: { ...base, lastCandleMs1m: 2 } })).not.toBe(
      baseKey,
    );
    expect(cacheKeyFor({ manifest: { ...base, filterVersion: 2 } })).not.toBe(
      baseKey,
    );
    expect(cacheKeyFor({ manifest: { ...base, pipelineVersion: 2 } })).not.toBe(
      baseKey,
    );
  });

  it("yields distinct keys per kind even with overlapping fields", () => {
    const size: SizeDistributionCacheManifest = {
      kind: "size",
      series,
      asset: "btc",
      lastCandleMs5m: 1,
      algoVersion: 1,
    };
    const survival = {
      kind: "survival" as const,
      series,
      asset: "btc",
      lastCandleMs1m: 1,
      lastCandleMs5m: 1,
      pipelineVersion: 1,
    };
    expect(cacheKeyFor({ manifest: size })).not.toBe(
      cacheKeyFor({ manifest: survival }),
    );
  });
});
