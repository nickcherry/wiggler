import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";

import { z } from "zod";

const repoRoot = resolvePath(import.meta.dir, "../../../..");

/**
 * Default location of the lifetime-PnL checkpoint file. The runtime
 * is DB-free by design, so a single small JSON file under `tmp/` is
 * the only persistent state the live trader maintains. Operators on a
 * production server can symlink `tmp/` somewhere they control if they
 * want this on durable storage; the default keeps it next to the
 * code without any setup.
 */
export const DEFAULT_LIFETIME_PNL_PATH = resolvePath(
  repoRoot,
  "tmp/lifetime-pnl.json",
);

const lifetimePnlSchema = z.object({
  /**
   * The Polymarket funder/wallet address the value was accumulated
   * for. Different wallet → cold start, on the assumption that the
   * operator has switched bots.
   */
  walletAddress: z.string().min(1),
  lifetimePnlUsd: z.number().finite(),
  /** Epoch ms of the last write — operational/debugging metadata. */
  asOfMs: z.int().nonnegative(),
});

export type LifetimePnlLoadResult =
  | {
      readonly source: "loaded";
      readonly lifetimePnlUsd: number;
      readonly asOfMs: number;
    }
  | {
      readonly source: "cold";
      readonly lifetimePnlUsd: 0;
      readonly reason: "missing-file" | "wallet-mismatch" | "corrupt";
      readonly detail?: string;
    };

/**
 * Loads the lifetime-PnL checkpoint from disk if it exists and matches
 * the running wallet. Cold-starts (returning 0) for these reasons:
 *
 *   - File doesn't exist → first time the live trader has ever run with
 *     this code on this host. Lifetime begins from this run.
 *   - File exists but the wallet doesn't match → operator has rotated
 *     wallets; previous lifetime applied to a different funder, so we
 *     don't carry it over.
 *   - File exists but is unparseable / fails the schema → corrupt;
 *     don't trust it. Fail-soft to a cold start so the bot keeps
 *     running.
 */
export async function loadLifetimePnl({
  walletAddress,
  path = DEFAULT_LIFETIME_PNL_PATH,
}: {
  readonly walletAddress: string;
  readonly path?: string;
}): Promise<LifetimePnlLoadResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { source: "cold", lifetimePnlUsd: 0, reason: "missing-file" };
    }
    throw error;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    return {
      source: "cold",
      lifetimePnlUsd: 0,
      reason: "corrupt",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const parsed = lifetimePnlSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      source: "cold",
      lifetimePnlUsd: 0,
      reason: "corrupt",
      detail: parsed.error.message,
    };
  }
  if (parsed.data.walletAddress !== walletAddress) {
    return { source: "cold", lifetimePnlUsd: 0, reason: "wallet-mismatch" };
  }
  return {
    source: "loaded",
    lifetimePnlUsd: parsed.data.lifetimePnlUsd,
    asOfMs: parsed.data.asOfMs,
  };
}

/**
 * Atomically writes the checkpoint. Uses a per-process tmp filename
 * plus rename so a crash between `writeFile` and `rename` leaves the
 * existing checkpoint intact. The tmp file lands in the same
 * directory as the target so the rename stays inside one filesystem.
 */
export async function persistLifetimePnl({
  walletAddress,
  lifetimePnlUsd,
  path = DEFAULT_LIFETIME_PNL_PATH,
}: {
  readonly walletAddress: string;
  readonly lifetimePnlUsd: number;
  readonly path?: string;
}): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body = JSON.stringify(
    {
      walletAddress,
      lifetimePnlUsd,
      asOfMs: Date.now(),
    },
    null,
    2,
  );
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${body}\n`, "utf8");
  await rename(tmpPath, path);
}
