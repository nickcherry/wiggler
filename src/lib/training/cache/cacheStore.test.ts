import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";

import type {
  SizeDistributionCacheManifest,
  SurvivalFilterCacheManifest,
} from "@alea/lib/training/cache/cacheManifests";
import { TrainingCacheStore } from "@alea/lib/training/cache/cacheStore";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const series = { source: "binance", product: "perp", timeframe: "5m" } as const;

let root: string;
let store: TrainingCacheStore;

beforeEach(async () => {
  root = await mkdtemp(resolvePath(tmpdir(), "alea-cache-test-"));
  store = new TrainingCacheStore({ root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const sizeManifest: SizeDistributionCacheManifest = {
  kind: "size",
  series,
  asset: "btc",
  lastCandleMs5m: 1,
  algoVersion: 1,
};

const filterManifest: SurvivalFilterCacheManifest = {
  kind: "filter",
  series,
  asset: "btc",
  lastCandleMs1m: 1,
  lastCandleMs5m: 1,
  pipelineVersion: 1,
  filterId: "f",
  filterVersion: 1,
};

describe("TrainingCacheStore", () => {
  it("returns null on miss", async () => {
    const value = await store.get<{ x: number }>({ manifest: sizeManifest });
    expect(value).toBeNull();
  });

  it("round-trips a value through set/get", async () => {
    await store.set({ manifest: sizeManifest, value: { x: 42 } });
    const value = await store.get<{ x: number }>({ manifest: sizeManifest });
    expect(value).toEqual({ x: 42 });
  });

  it("isolates entries by manifest kind on disk", async () => {
    await store.set({ manifest: sizeManifest, value: { kind: "size" } });
    await store.set({ manifest: filterManifest, value: { kind: "filter" } });
    const sizeDir = await readdir(resolvePath(root, "size"));
    const filterDir = await readdir(resolvePath(root, "filters"));
    expect(sizeDir.length).toBe(1);
    expect(filterDir.length).toBe(1);
  });

  it("misses when any manifest field changes (different key)", async () => {
    await store.set({ manifest: filterManifest, value: { v: 1 } });
    const bumpedVersion = await store.get({
      manifest: { ...filterManifest, filterVersion: 2 },
    });
    const newerCandles = await store.get({
      manifest: { ...filterManifest, lastCandleMs1m: 2 },
    });
    expect(bumpedVersion).toBeNull();
    expect(newerCandles).toBeNull();
  });

  it("pruneUnused deletes only entries not touched this run", async () => {
    // Pre-populate two filter entries via direct sets.
    await store.set({ manifest: filterManifest, value: { v: 1 } });
    await store.set({
      manifest: { ...filterManifest, filterId: "g" },
      value: { v: 2 },
    });

    // New "run" — fresh store sharing the same root. Touch only the
    // first manifest; the second should be pruned.
    const next = new TrainingCacheStore({ root });
    await next.get({ manifest: filterManifest });
    const result = await next.pruneUnused();
    expect(result.deleted).toBe(1);
    const remaining = await readdir(resolvePath(root, "filters"));
    expect(remaining.length).toBe(1);
  });
});
