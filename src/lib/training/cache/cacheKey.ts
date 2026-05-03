import { createHash } from "node:crypto";

import type { CacheManifest } from "@alea/lib/training/cache/cacheManifests";

/**
 * Cache key length, in hex chars. 16 hex = 64 bits, plenty of collision
 * resistance at the few-thousand-entries-per-machine scale we expect for
 * `tmp/cache/`. Short enough to leave readable filenames.
 */
const KEY_LENGTH = 16;

/**
 * Computes the cache key for a manifest. Same manifest → same key,
 * regardless of process or machine. Field reordering doesn't matter
 * because we serialize with sorted keys before hashing.
 */
export function cacheKeyFor({
  manifest,
}: {
  readonly manifest: CacheManifest;
}): string {
  const canonical = canonicalize(manifest);
  return createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, KEY_LENGTH);
}

/**
 * Stable JSON serialization with deterministic key ordering at every
 * level. Uses recursion rather than `JSON.stringify`'s replacer because
 * the replacer can't reorder nested object keys. Arrays preserve order;
 * primitives stringify as JSON literals.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return (
    "{" +
    entries
      .map(([k, v]) => JSON.stringify(k) + ":" + canonicalize(v))
      .join(",") +
    "}"
  );
}
