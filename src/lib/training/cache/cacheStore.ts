import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import { cacheKeyFor } from "@alea/lib/training/cache/cacheKey";
import type { CacheManifest } from "@alea/lib/training/cache/cacheManifests";

/**
 * Subdirectory under the cache root for each manifest kind. Keeping
 * shapes in separate folders makes pruning cheap (we only walk the
 * folders we know about) and keeps the on-disk layout legible.
 */
const KIND_DIR = {
  size: "size",
  survival: "survival",
  filter: "filters",
} as const;

/**
 * Persisted shape of every cache file. The manifest is stored alongside
 * the value so an operator grepping `tmp/cache/` can answer "which
 * filter, which dataset, which version?" without consulting the code.
 */
type CacheFile<T> = {
  readonly manifest: CacheManifest;
  readonly value: T;
};

/**
 * Filesystem-backed cache for the `training:distributions` pipeline.
 * One instance per command run; tracks the keys it served so the prune
 * step can delete stale entries (different timestamps, removed filters,
 * version bumps) without touching files the run still depends on.
 */
export class TrainingCacheStore {
  private readonly root: string;
  private readonly usedKeys = new Map<string, Set<string>>();

  constructor({ root }: { readonly root: string }) {
    this.root = root;
  }

  /**
   * Returns the cached value for the given manifest, or `null` on miss.
   * Records the key as used so the prune step won't delete the file.
   * Treats any read or parse error as a miss — the cache is throwaway,
   * not load-bearing.
   */
  async get<T>({
    manifest,
  }: {
    readonly manifest: CacheManifest;
  }): Promise<T | null> {
    const { dir, key } = this.resolve({ manifest });
    this.markUsed({ kind: manifest.kind, key });
    const path = resolvePath(dir, key + ".json");
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as CacheFile<T>;
      return parsed.value;
    } catch {
      return null;
    }
  }

  /**
   * Persists a value under the manifest's cache key. Overwrites any
   * existing entry for the same key. Marks the key as used.
   */
  async set<T>({
    manifest,
    value,
  }: {
    readonly manifest: CacheManifest;
    readonly value: T;
  }): Promise<void> {
    const { dir, key } = this.resolve({ manifest });
    this.markUsed({ kind: manifest.kind, key });
    await mkdir(dir, { recursive: true });
    const body: CacheFile<T> = { manifest, value };
    await writeFile(resolvePath(dir, key + ".json"), JSON.stringify(body));
  }

  /**
   * Deletes any cache file whose key wasn't touched by `get`/`set` during
   * this run. Run once at the end of the command — anything not used is
   * either stale (data refreshed, version bumped) or orphaned (filter
   * removed from the registry).
   */
  async pruneUnused(): Promise<{ readonly deleted: number }> {
    let deleted = 0;
    for (const kind of Object.keys(KIND_DIR) as Array<keyof typeof KIND_DIR>) {
      const dir = resolvePath(this.root, KIND_DIR[kind]);
      const used = this.usedKeys.get(kind) ?? new Set<string>();
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith(".json")) {
          continue;
        }
        const key = entry.slice(0, -".json".length);
        if (used.has(key)) {
          continue;
        }
        try {
          await unlink(resolvePath(dir, entry));
          deleted += 1;
        } catch {
          // Best-effort prune — ignore unlink errors.
        }
      }
    }
    return { deleted };
  }

  private resolve({ manifest }: { readonly manifest: CacheManifest }): {
    readonly dir: string;
    readonly key: string;
  } {
    return {
      dir: resolvePath(this.root, KIND_DIR[manifest.kind]),
      key: cacheKeyFor({ manifest }),
    };
  }

  private markUsed({
    kind,
    key,
  }: {
    readonly kind: string;
    readonly key: string;
  }): void {
    let set = this.usedKeys.get(kind);
    if (set === undefined) {
      set = new Set<string>();
      this.usedKeys.set(kind, set);
    }
    set.add(key);
  }
}
