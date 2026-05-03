import { mkdir } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import { assetValues } from "@alea/constants/assets";
import { trainingCandleSeries } from "@alea/constants/training";
import { defineCommand } from "@alea/lib/cli/defineCommand";
import { defineFlagOption } from "@alea/lib/cli/defineFlagOption";
import { defineValueOption } from "@alea/lib/cli/defineValueOption";
import { createDatabase } from "@alea/lib/db/createDatabase";
import { destroyDatabase } from "@alea/lib/db/destroyDatabase";
import { openHtmlOnDarwin } from "@alea/lib/exchangePrices/openHtmlOnDarwin";
import { computeCandleSizeDistribution } from "@alea/lib/training/computeCandleSizeDistribution";
import { computeSurvivalDistribution } from "@alea/lib/training/computeSurvivalDistribution";
import { computeSurvivalSnapshots } from "@alea/lib/training/computeSurvivalSnapshots";
import { loadTrainingCandles } from "@alea/lib/training/loadTrainingCandles";
import { applySurvivalFilters } from "@alea/lib/training/survivalFilters/applySurvivalFilters";
import { survivalFilters } from "@alea/lib/training/survivalFilters/registry";
import type {
  AssetSizeDistribution,
  AssetSurvivalDistribution,
  AssetSurvivalFilters,
  TrainingDistributionsPayload,
} from "@alea/lib/training/types";
import { writeTrainingDistributionsArtifacts } from "@alea/lib/training/writeTrainingDistributionsArtifacts";
import { assetSchema } from "@alea/types/assets";
import pc from "picocolors";
import { z } from "zod";

const tmpDir = resolvePath(import.meta.dir, "../../../tmp");

/**
 * Computes the distribution of 5-minute candle body and wick sizes (each
 * expressed as a percentage of the bar's open price) for every requested
 * asset in the local Postgres, then writes a paired HTML dashboard and JSON
 * sidecar to `alea/tmp/`.
 *
 * The series studied is fixed by `trainingCandleSeries` (today: binance-perp
 * 5m). The HTML page tabs across assets and shows the totals only; the JSON
 * sidecar additionally carries the per-year breakdown.
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
  ],
  examples: [
    "bun alea training:distributions",
    "bun alea training:distributions --assets btc,eth",
    "bun alea training:distributions --no-open",
  ],
  output:
    "Prints per-asset row counts and the paths of the HTML + JSON artifacts.",
  sideEffects:
    "Reads the candles table; writes one HTML and one JSON file to alea/tmp/.",
  async run({ io, options }) {
    io.writeStdout(
      `${pc.bold("training:distributions")}  ${pc.dim("series=")}${trainingCandleSeries.source}-${trainingCandleSeries.product}  ${pc.dim("timeframe=")}${trainingCandleSeries.timeframe}  ${pc.dim("assets=")}${options.assets.join(",")}\n\n`,
    );

    const db = createDatabase();
    const distributions: AssetSizeDistribution[] = [];
    const survivalDistributions: AssetSurvivalDistribution[] = [];
    const survivalFilterResults: AssetSurvivalFilters[] = [];

    try {
      for (const asset of options.assets) {
        const candles = await loadTrainingCandles({ db, asset });
        const distribution = computeCandleSizeDistribution({ asset, candles });
        if (distribution === null) {
          io.writeStdout(
            `${pc.bold(asset.toUpperCase().padEnd(5))} ${pc.yellow("no candles")}\n`,
          );
          continue;
        }
        distributions.push(distribution);

        // Survival surface needs 1m candles for the same asset. The 1m
        // backfill is independent of the 5m one — if it isn't ready yet
        // for this asset, we skip the survival computation but still emit
        // the size distribution.
        const candles1m = await loadTrainingCandles({
          db,
          asset,
          timeframe: "1m",
        });
        const survival = computeSurvivalDistribution({
          asset,
          candles: candles1m,
        });
        if (survival !== null) {
          survivalDistributions.push(survival);
          // Filter framework needs the same 1m series plus the 5m series
          // for MA-20 / prev-5m context. Reuse `candles` (the 5m series
          // we already loaded for the size distribution).
          const { perFilter } = applySurvivalFilters({
            snapshots: computeSurvivalSnapshots({
              candles1m,
              candles5m: candles,
            }),
            filters: survivalFilters,
          });
          survivalFilterResults.push({ asset, results: perFilter });
        }

        const yearKeys = Object.keys(distribution.byYear).sort();
        const survivalLabel =
          survival === null
            ? pc.yellow("no 1m")
            : `${pc.dim("windows=")}${survival.windowCount.toLocaleString()} ${pc.dim("filters=")}${survivalFilters.length}`;
        io.writeStdout(
          `${pc.bold(asset.toUpperCase().padEnd(5))} ` +
            `${pc.dim("rows=")}${String(distribution.candleCount).padStart(8)} ` +
            `${pc.dim("years=")}${yearKeys.length > 0 ? yearKeys.join(",") : "—"} ` +
            `${survivalLabel}\n`,
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
  },
});

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
