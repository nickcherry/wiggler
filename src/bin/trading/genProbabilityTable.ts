import { mkdir, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import { assetValues } from "@alea/constants/assets";
import { MIN_BUCKET_SAMPLES } from "@alea/constants/trading";
import { trainingCandleSeries } from "@alea/constants/training";
import { defineCommand } from "@alea/lib/cli/defineCommand";
import { defineValueOption } from "@alea/lib/cli/defineValueOption";
import { createDatabase } from "@alea/lib/db/createDatabase";
import { destroyDatabase } from "@alea/lib/db/destroyDatabase";
import type { DatabaseClient } from "@alea/lib/db/types";
import { computeAssetProbabilities } from "@alea/lib/trading/computeAssetProbabilities";
import { writeProbabilityTableModule } from "@alea/lib/trading/probabilityTable/writeProbabilityTableModule";
import type {
  AssetProbabilities,
  ProbabilityTable,
} from "@alea/lib/trading/types";
import { loadTrainingCandles } from "@alea/lib/training/loadTrainingCandles";
import type { Asset } from "@alea/types/assets";
import { assetSchema } from "@alea/types/assets";
import pc from "picocolors";
import { z } from "zod";

const repoRoot = resolvePath(import.meta.dir, "../../..");
const generatedPath = resolvePath(
  repoRoot,
  "src/lib/trading/probabilityTable/probabilityTable.generated.ts",
);
const tmpDir = resolvePath(repoRoot, "tmp");

/**
 * Generates the committed `probabilityTable.generated.ts` artifact that
 * the live trader loads at boot. Reuses the survival snapshot pipeline
 * (so the bucketing math is identical to what we vet on the training
 * dashboard) but applies only the live filter
 * (`LIVE_TRADING_FILTER` — see `src/constants/liveTrading.ts`) and
 * writes a lean per-asset surface restricted to that filter's
 * sweet-spot bp range. No HTML, no scoring caches — this is the
 * production model checked into version control.
 *
 * Run after the candle sync is up to date; the per-asset summary line
 * shows the discovered sweet-spot range and bucket counts so it's
 * obvious if the data is thin or if the sweet spot has shifted from a
 * prior run.
 */
export const tradingGenProbabilityTableCommand = defineCommand({
  name: "trading:gen-probability-table",
  summary:
    "Refresh the committed live-trading probability table from local candles",
  description:
    "Reads the local Postgres for the configured training candle series (today: binance-perp 5m + the matching 1m series) and writes src/lib/trading/probabilityTable/probabilityTable.generated.ts plus a JSON sidecar in tmp/. The model uses LIVE_TRADING_FILTER (snapshot is `aligned`/decisively away when |distance| ≥ 0.5 × ATR at the configured period) and only persists buckets within the per-asset sweet-spot bp range. Buckets thinner than --min-samples are dropped.",
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
    defineValueOption({
      key: "minSamples",
      long: "--min-samples",
      valueName: "N",
      schema: z.coerce
        .number()
        .int()
        .positive()
        .default(MIN_BUCKET_SAMPLES)
        .describe(
          `Drop buckets with fewer historical observations than this (default ${MIN_BUCKET_SAMPLES}).`,
        ),
    }),
  ],
  examples: [
    "bun alea trading:gen-probability-table",
    "bun alea trading:gen-probability-table --assets btc,eth",
    "bun alea trading:gen-probability-table --min-samples 500",
  ],
  output:
    "Per-asset window/bucket counts and the paths of the generated TS module + JSON sidecar.",
  sideEffects:
    "Reads the candles table; OVERWRITES src/lib/trading/probabilityTable/probabilityTable.generated.ts; writes a JSON sidecar to alea/tmp/.",
  async run({ io, options }) {
    io.writeStdout(
      `${pc.bold("trading:gen-probability-table")}  ${pc.dim("series=")}${trainingCandleSeries.source}-${trainingCandleSeries.product}  ${pc.dim("assets=")}${options.assets.join(",")}  ${pc.dim("min-samples=")}${options.minSamples}\n\n`,
    );

    const db = createDatabase();
    const perAsset: AssetProbabilities[] = [];
    let firstWindowMs = Number.POSITIVE_INFINITY;
    let lastWindowMs = 0;

    try {
      for (const asset of options.assets) {
        const result = await processAsset({
          db,
          asset,
          minBucketSamples: options.minSamples,
        });
        if (result === null) {
          io.writeStdout(
            `${pc.bold(asset.toUpperCase().padEnd(5))} ${pc.yellow("no usable windows")}\n`,
          );
          continue;
        }
        perAsset.push(result.probabilities);
        firstWindowMs = Math.min(firstWindowMs, result.firstWindowMs);
        lastWindowMs = Math.max(lastWindowMs, result.lastWindowMs);

        const aligned = countBuckets({
          probabilities: result.probabilities,
          aligned: true,
        });
        const notAligned = countBuckets({
          probabilities: result.probabilities,
          aligned: false,
        });
        const ss = result.probabilities.sweetSpot;
        const sweetSpotLabel = ss
          ? `[${ss.startBp}-${ss.endBp}] cov=${(ss.coverageFraction * 100).toFixed(1)}%`
          : "—";
        io.writeStdout(
          `${pc.bold(asset.toUpperCase().padEnd(5))} ` +
            `${pc.dim("windows=")}${String(result.probabilities.windowCount).padStart(7)} ` +
            `${pc.dim("aligned=")}${(result.probabilities.alignedWindowShare * 100).toFixed(1).padStart(5)}% ` +
            `${pc.dim("sweet=")}${sweetSpotLabel.padEnd(20)} ` +
            `${pc.dim("buckets=")}${String(aligned).padStart(4)}/${String(notAligned).padEnd(4)}\n`,
        );
      }
    } finally {
      await destroyDatabase(db);
    }

    if (perAsset.length === 0) {
      io.writeStdout(
        `\n${pc.yellow("no probabilities computed; not touching the generated file")}\n`,
      );
      return;
    }

    const table: ProbabilityTable = {
      command: "trading:gen-probability-table",
      schemaVersion: 1,
      generatedAtMs: Date.now(),
      series: trainingCandleSeries,
      minBucketSamples: options.minSamples,
      trainingRangeMs: {
        firstWindowMs:
          firstWindowMs === Number.POSITIVE_INFINITY ? 0 : firstWindowMs,
        lastWindowMs,
      },
      assets: perAsset,
    };

    await writeProbabilityTableModule({ table, path: generatedPath });

    await mkdir(tmpDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const jsonPath = resolvePath(tmpDir, `probability-table_${stamp}.json`);
    await writeFile(jsonPath, JSON.stringify(table, null, 2), "utf8");

    io.writeStdout(
      `\n${pc.green("wrote")} ${pc.dim(generatedPath)}\n${pc.green("wrote")} ${pc.dim(jsonPath)}\n`,
    );
  },
});

type AssetResult = {
  readonly probabilities: AssetProbabilities;
  readonly firstWindowMs: number;
  readonly lastWindowMs: number;
};

async function processAsset({
  db,
  asset,
  minBucketSamples,
}: {
  readonly db: DatabaseClient;
  readonly asset: Asset;
  readonly minBucketSamples: number;
}): Promise<AssetResult | null> {
  const candles1m = await loadTrainingCandles({ db, asset, timeframe: "1m" });
  if (candles1m.length === 0) {
    return null;
  }
  const candles5m = await loadTrainingCandles({ db, asset });
  const probabilities = computeAssetProbabilities({
    asset,
    candles1m,
    candles5m,
    minBucketSamples,
  });
  if (probabilities === null) {
    return null;
  }
  const firstWindowMs = candles1m[0]?.timestamp.getTime() ?? 0;
  const lastWindowMs =
    candles1m[candles1m.length - 1]?.timestamp.getTime() ?? 0;
  return { probabilities, firstWindowMs, lastWindowMs };
}

function countBuckets({
  probabilities,
  aligned,
}: {
  readonly probabilities: AssetProbabilities;
  readonly aligned: boolean;
}): number {
  const surface = aligned ? probabilities.aligned : probabilities.notAligned;
  return (
    surface.byRemaining[1].length +
    surface.byRemaining[2].length +
    surface.byRemaining[3].length +
    surface.byRemaining[4].length
  );
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
