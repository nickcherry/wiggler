import { mkdir } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import { assetValues } from "@alea/constants/assets";
import { trainingCandleSeries } from "@alea/constants/training";
import { defineCommand } from "@alea/lib/cli/defineCommand";
import { defineFlagOption } from "@alea/lib/cli/defineFlagOption";
import { defineValueOption } from "@alea/lib/cli/defineValueOption";
import { createDatabase } from "@alea/lib/db/createDatabase";
import { destroyDatabase } from "@alea/lib/db/destroyDatabase";
import type { DatabaseClient } from "@alea/lib/db/types";
import { openHtmlOnDarwin } from "@alea/lib/exchangePrices/openHtmlOnDarwin";
import type {
  SizeDistributionCacheManifest,
  SurvivalDistributionCacheManifest,
  SurvivalFilterCacheManifest,
} from "@alea/lib/training/cache/cacheManifests";
import { TrainingCacheStore } from "@alea/lib/training/cache/cacheStore";
import {
  computeCandleSizeDistribution,
  SIZE_DISTRIBUTION_VERSION,
} from "@alea/lib/training/computeCandleSizeDistribution";
import {
  computeSurvivalSnapshots,
  SNAPSHOT_PIPELINE_VERSION,
} from "@alea/lib/training/computeSurvivalSnapshots";
import { deployTrainingDashboard } from "@alea/lib/training/deployTrainingDashboard";
import { loadMaxCandleTimestamp } from "@alea/lib/training/loadMaxCandleTimestamp";
import { loadTrainingCandles } from "@alea/lib/training/loadTrainingCandles";
import { applySurvivalFilters } from "@alea/lib/training/survivalFilters/applySurvivalFilters";
import { survivalFilters } from "@alea/lib/training/survivalFilters/registry";
import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";
import type {
  AssetSizeDistribution,
  AssetSurvivalDistribution,
  AssetSurvivalFilters,
  SurvivalFilterResultPayload,
  TrainingDistributionsPayload,
} from "@alea/lib/training/types";
import { writeTrainingDistributionsArtifacts } from "@alea/lib/training/writeTrainingDistributionsArtifacts";
import type { Asset } from "@alea/types/assets";
import { assetSchema } from "@alea/types/assets";
import pc from "picocolors";
import { z } from "zod";

const tmpDir = resolvePath(import.meta.dir, "../../../tmp");
const cacheDir = resolvePath(tmpDir, "cache/training-distributions");

/**
 * Computes the distribution of 5-minute candle body and wick sizes (each
 * expressed as a percentage of the bar's open price), the
 * point-of-no-return survival surface, and every binary filter overlay
 * for every requested asset in the local Postgres, then writes a paired
 * HTML dashboard and JSON sidecar to `alea/tmp/`.
 *
 * Heavy intermediate results are cached per asset under
 * `tmp/cache/training-distributions/`. Cache keys mix in the relevant
 * data freshness (max candle timestamp) and the algorithm/filter
 * versions, so re-runs with no changes are near-free, and adding a
 * single new filter recomputes only that filter.
 */
export const trainingDistributionsCommand = defineCommand({
  name: "training:distributions",
  summary: "Compute candle body/wick percentile distributions per asset",
  description:
    "Reads the local Postgres for the configured training candle series (today: binance-perp 5m) and computes percentile distributions of the body (|close - open| / open) and wick ((high - low) / open) for each requested asset, outputting an HTML dashboard with one tab per asset plus a JSON sidecar containing the same data plus per-year breakdowns.",
  options: [
    defineValueOption({
      key: "assets",
      long: "--assets",
      valueName: "LIST",
      schema: z
        .string()
        .optional()
        .transform((value) => parseList(value))
        .pipe(z.array(assetSchema).default([...assetValues]))
        .describe("Comma-separated asset list (default: all whitelisted)."),
    }),
    defineFlagOption({
      key: "noOpen",
      long: "--no-open",
      schema: z
        .boolean()
        .default(false)
        .describe("Skip auto-opening the HTML dashboard on macOS."),
    }),
    defineFlagOption({
      key: "noCache",
      long: "--no-cache",
      schema: z
        .boolean()
        .default(false)
        .describe(
          "Bypass the on-disk cache and recompute everything from scratch.",
        ),
    }),
    defineFlagOption({
      key: "deploy",
      long: "--deploy",
      schema: z
        .boolean()
        .default(false)
        .describe(
          "After rendering the dashboard, push it to the alea Cloudflare Worker via Wrangler.",
        ),
    }),
  ],
  examples: [
    "bun alea training:distributions",
    "bun alea training:distributions --assets btc,eth",
    "bun alea training:distributions --no-open",
    "bun alea training:distributions --no-cache",
    "bun alea training:distributions --deploy --no-open",
  ],
  output:
    "Prints per-asset row counts and the paths of the HTML + JSON artifacts.",
  sideEffects:
    "Reads the candles table; writes one HTML and one JSON file to alea/tmp/; reads/writes intermediate JSON in tmp/cache/.",
  async run({ io, options }) {
    io.writeStdout(
      `${pc.bold("training:distributions")}  ${pc.dim("series=")}${trainingCandleSeries.source}-${trainingCandleSeries.product}  ${pc.dim("timeframe=")}${trainingCandleSeries.timeframe}  ${pc.dim("assets=")}${options.assets.join(",")}${options.noCache ? `  ${pc.yellow("[no-cache]")}` : ""}\n\n`,
    );

    const db = createDatabase();
    const cache = options.noCache
      ? null
      : new TrainingCacheStore({ root: cacheDir });
    const distributions: AssetSizeDistribution[] = [];
    const survivalDistributions: AssetSurvivalDistribution[] = [];
    const survivalFilterResults: AssetSurvivalFilters[] = [];

    try {
      for (const asset of options.assets) {
        const result = await processAsset({
          db,
          asset,
          cache,
        });
        if (result === null) {
          io.writeStdout(
            `${pc.bold(asset.toUpperCase().padEnd(5))} ${pc.yellow("no candles")}\n`,
          );
          continue;
        }
        distributions.push(result.distribution);
        if (result.survival !== null) {
          survivalDistributions.push(result.survival);
        }
        if (result.filterResults !== null) {
          survivalFilterResults.push(result.filterResults);
        }

        const yearKeys = Object.keys(result.distribution.byYear).sort();
        const survivalLabel =
          result.survival === null
            ? pc.yellow("no 1m")
            : `${pc.dim("windows=")}${result.survival.windowCount.toLocaleString()} ${pc.dim("filters=")}${survivalFilters.length}`;
        const cacheLabel = formatCacheLabel({
          hits: result.cacheHits,
          total: result.cacheTotal,
        });
        io.writeStdout(
          `${pc.bold(asset.toUpperCase().padEnd(5))} ` +
            `${pc.dim("rows=")}${String(result.distribution.candleCount).padStart(8)} ` +
            `${pc.dim("years=")}${yearKeys.length > 0 ? yearKeys.join(",") : "—"} ` +
            `${survivalLabel} ` +
            `${cacheLabel}\n`,
        );
      }
    } finally {
      await destroyDatabase(db);
    }

    if (distributions.length === 0) {
      io.writeStdout(
        `\n${pc.yellow("no distributions computed; nothing written")}\n`,
      );
      return;
    }

    await mkdir(tmpDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const htmlPath = resolvePath(
      tmpDir,
      `training-distributions_${stamp}.html`,
    );
    const jsonPath = resolvePath(
      tmpDir,
      `training-distributions_${stamp}.json`,
    );

    const payload = buildPayload({
      distributions,
      survivalDistributions,
      survivalFilterResults,
    });
    await writeTrainingDistributionsArtifacts({ payload, htmlPath, jsonPath });

    io.writeStdout(
      `\n${pc.green("wrote")} ${pc.dim(jsonPath)}\n${pc.green("wrote")} ${pc.dim(htmlPath)}\n`,
    );

    if (!options.noOpen) {
      openHtmlOnDarwin({ path: htmlPath });
    }

    if (options.deploy) {
      const repoRoot = resolvePath(import.meta.dir, "../../..");
      const webDir = resolvePath(repoRoot, "tmp/web");
      io.writeStdout(`\n${pc.bold("deploying")} ${pc.dim("to alea worker")}\n`);
      try {
        const { url } = await deployTrainingDashboard({
          htmlPath,
          webDir,
          cwd: repoRoot,
          onLog: (line) => io.writeStdout(pc.dim("  wrangler ") + line + "\n"),
        });
        io.writeStdout(`${pc.green("deployed")} ${pc.dim(url)}\n`);
      } catch (err) {
        io.writeStdout(
          `${pc.red("deploy failed:")} ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  },
});

/**
 * One-asset slice of the dashboard: size distribution, survival
 * distribution (or null if 1m candles aren't synced), per-filter results
 * (or null), plus cache instrumentation for the per-asset summary line.
 */
type AssetResult = {
  readonly distribution: AssetSizeDistribution;
  readonly survival: AssetSurvivalDistribution | null;
  readonly filterResults: AssetSurvivalFilters | null;
  readonly cacheHits: number;
  readonly cacheTotal: number;
};

/**
 * Runs the full per-asset pipeline against the cache. Loads only what
 * the cache forced us to load: a fully-cached asset doesn't touch the
 * candles table at all (just the cheap `MAX(timestamp)` probes).
 */
async function processAsset({
  db,
  asset,
  cache,
}: {
  readonly db: DatabaseClient;
  readonly asset: Asset;
  readonly cache: TrainingCacheStore | null;
}): Promise<AssetResult | null> {
  const lastCandleMs5m = await loadMaxCandleTimestamp({ db, asset });
  if (lastCandleMs5m === null) {
    return null;
  }
  const lastCandleMs1m = await loadMaxCandleTimestamp({
    db,
    asset,
    timeframe: "1m",
  });

  const sizeManifest: SizeDistributionCacheManifest = {
    kind: "size",
    series: trainingCandleSeries,
    asset,
    lastCandleMs5m,
    algoVersion: SIZE_DISTRIBUTION_VERSION,
  };
  const cachedSize =
    cache === null
      ? null
      : await cache.get<AssetSizeDistribution>({ manifest: sizeManifest });

  let survivalManifest: SurvivalDistributionCacheManifest | null = null;
  let cachedSurvival: AssetSurvivalDistribution | null = null;
  const filterCacheState: {
    filter: SurvivalFilter;
    manifest: SurvivalFilterCacheManifest;
    cached: SurvivalFilterResultPayload | null;
  }[] = [];

  if (lastCandleMs1m !== null) {
    survivalManifest = {
      kind: "survival",
      series: trainingCandleSeries,
      asset,
      lastCandleMs1m,
      lastCandleMs5m,
      pipelineVersion: SNAPSHOT_PIPELINE_VERSION,
    };
    cachedSurvival =
      cache === null
        ? null
        : await cache.get<AssetSurvivalDistribution>({
            manifest: survivalManifest,
          });
    for (const filter of survivalFilters) {
      const manifest: SurvivalFilterCacheManifest = {
        kind: "filter",
        series: trainingCandleSeries,
        asset,
        lastCandleMs1m,
        lastCandleMs5m,
        pipelineVersion: SNAPSHOT_PIPELINE_VERSION,
        filterId: filter.id,
        filterVersion: filter.version,
      };
      const cached =
        cache === null
          ? null
          : await cache.get<SurvivalFilterResultPayload>({ manifest });
      filterCacheState.push({ filter, manifest, cached });
    }
  }

  const needSize = cachedSize === null;
  const needSurvival = lastCandleMs1m !== null && cachedSurvival === null;
  const missingFilters = filterCacheState.filter((s) => s.cached === null);
  const needAnyFilter = missingFilters.length > 0;
  const needSnapshotPass = needSurvival || needAnyFilter;

  // Bookkeeping for the per-asset summary line: hits / total across the
  // size + survival + per-filter cache layers.
  const cacheTotal =
    1 + (lastCandleMs1m !== null ? 1 : 0) + filterCacheState.length;
  const cacheHits =
    (cachedSize === null ? 0 : 1) +
    (cachedSurvival === null ? 0 : 1) +
    filterCacheState.reduce((acc, s) => acc + (s.cached === null ? 0 : 1), 0);

  // Load only what we need. 5m candles power the size dist AND the
  // snapshot pipeline's prev-5m / MA-20 context, so they're needed if
  // either layer missed.
  const need5m = needSize || needSnapshotPass;
  const candles5m = need5m ? await loadTrainingCandles({ db, asset }) : null;
  const need1m = needSnapshotPass;
  const candles1m = need1m
    ? await loadTrainingCandles({ db, asset, timeframe: "1m" })
    : null;

  // Size distribution: from cache, or freshly computed.
  let distribution: AssetSizeDistribution | null;
  if (cachedSize !== null) {
    distribution = cachedSize;
  } else {
    if (candles5m === null) {
      throw new Error("unreachable: needed 5m candles but never loaded them");
    }
    distribution = computeCandleSizeDistribution({ asset, candles: candles5m });
    if (distribution !== null && cache !== null) {
      await cache.set({ manifest: sizeManifest, value: distribution });
    }
  }
  if (distribution === null) {
    return null;
  }

  // Survival + filters.
  let survival: AssetSurvivalDistribution | null = cachedSurvival;
  let perFilter: SurvivalFilterResultPayload[] | null =
    filterCacheState.length === 0
      ? null
      : filterCacheState.map((s) => s.cached as SurvivalFilterResultPayload);

  if (needSnapshotPass) {
    if (candles1m === null || candles5m === null) {
      throw new Error(
        "unreachable: needed snapshots but never loaded the source candles",
      );
    }
    // Run only the missing filters through the framework. The baseline
    // is produced by the same single sweep regardless of how many
    // filters we run, so we get cheap baseline data when the survival
    // layer also missed.
    const filtersToRun = missingFilters.map((s) => s.filter);
    const {
      baseline,
      baselineByYear,
      perFilter: freshPerFilter,
    } = applySurvivalFilters({
      snapshots: computeSurvivalSnapshots({
        candles1m,
        candles5m,
      }),
      filters: filtersToRun,
    });
    if (
      survivalManifest !== null &&
      cachedSurvival === null &&
      baseline.windowCount > 0
    ) {
      const fresh: AssetSurvivalDistribution = {
        asset,
        windowCount: baseline.windowCount,
        all: { byRemaining: baseline.byRemaining },
        byYear: baselineByYear,
      };
      survival = fresh;
      if (cache !== null) {
        await cache.set({ manifest: survivalManifest, value: fresh });
      }
    }
    if (perFilter === null) {
      perFilter = filterCacheState.map(
        (s) => s.cached as SurvivalFilterResultPayload,
      );
    }
    for (let i = 0; i < missingFilters.length; i += 1) {
      const slot = missingFilters[i];
      const fresh = freshPerFilter[i];
      if (slot === undefined || fresh === undefined) {
        continue;
      }
      const idx = filterCacheState.findIndex(
        (s) => s.filter.id === slot.filter.id,
      );
      if (idx < 0) {
        continue;
      }
      perFilter[idx] = fresh;
      if (cache !== null) {
        await cache.set({ manifest: slot.manifest, value: fresh });
      }
    }
  }

  const filterResults: AssetSurvivalFilters | null =
    perFilter === null ? null : { asset, results: perFilter };

  return {
    distribution,
    survival,
    filterResults,
    cacheHits,
    cacheTotal,
  };
}

function formatCacheLabel({
  hits,
  total,
}: {
  readonly hits: number;
  readonly total: number;
}): string {
  if (total === 0) {
    return "";
  }
  const ratio = `${hits}/${total}`;
  if (hits === total) {
    return `${pc.dim("cache=")}${pc.green(ratio)}`;
  }
  if (hits === 0) {
    return `${pc.dim("cache=")}${pc.yellow(ratio)}`;
  }
  return `${pc.dim("cache=")}${pc.cyan(ratio)}`;
}

function buildPayload({
  distributions,
  survivalDistributions,
  survivalFilterResults,
}: {
  readonly distributions: readonly AssetSizeDistribution[];
  readonly survivalDistributions: readonly AssetSurvivalDistribution[];
  readonly survivalFilterResults: readonly AssetSurvivalFilters[];
}): TrainingDistributionsPayload {
  return {
    command: "training:distributions",
    generatedAtMs: Date.now(),
    series: trainingCandleSeries,
    assets: distributions,
    survival: survivalDistributions,
    survivalFilters: survivalFilterResults,
  };
}

function parseList(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parts = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return parts.length > 0 ? parts : undefined;
}
