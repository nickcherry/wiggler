import { assetValues } from "@wiggler/constants/assets";
import { candleTimeframeValues } from "@wiggler/constants/candles";
import { productValues } from "@wiggler/constants/products";
import { candleSourceValues } from "@wiggler/constants/sources";
import {
  fillCandleGaps,
  type FillCandleGapsResult,
} from "@wiggler/lib/candles/fillCandleGaps";
import { defineCommand } from "@wiggler/lib/cli/defineCommand";
import { defineValueOption } from "@wiggler/lib/cli/defineValueOption";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import type { Asset } from "@wiggler/types/assets";
import { assetSchema } from "@wiggler/types/assets";
import { candleTimeframeSchema } from "@wiggler/types/candles";
import type { Product } from "@wiggler/types/products";
import { productSchema } from "@wiggler/types/products";
import type { CandleSource } from "@wiggler/types/sources";
import { candleSourceSchema } from "@wiggler/types/sources";
import pc from "picocolors";
import { z } from "zod";

const fillConcurrency = 8;

/**
 * Re-queries each configured (source, asset, product, timeframe) series for
 * any missing 5-min bars between the persisted min and max, upserting
 * whatever the source returns now. Useful after a large historical sync
 * when one or two venues had transient outages whose data has since been
 * backfilled by the venue.
 */
export const candlesFillGapsCommand = defineCommand({
  name: "candles:fill-gaps",
  summary: "Refetch missing candle bars from each source",
  description:
    "Identify per-series gaps (timestamps between min and max with no row) and re-pull each gap window from the source, upserting any rows the API now returns. Some venue outages get backfilled later and become recoverable on a follow-up pull.",
  options: [
    defineValueOption({
      key: "timeframe",
      long: "--timeframe",
      short: "-t",
      valueName: "TIMEFRAME",
      choices: candleTimeframeValues,
      schema: candleTimeframeSchema
        .default("5m")
        .describe("Candle timeframe to repair."),
    }),
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
      key: "sources",
      long: "--sources",
      valueName: "LIST",
      schema: z
        .string()
        .optional()
        .transform((value) => parseList(value))
        .pipe(z.array(candleSourceSchema).default([...candleSourceValues]))
        .describe("Comma-separated sources: coinbase,binance."),
    }),
    defineValueOption({
      key: "products",
      long: "--products",
      valueName: "LIST",
      schema: z
        .string()
        .optional()
        .transform((value) => parseList(value))
        .pipe(z.array(productSchema).default([...productValues]))
        .describe("Comma-separated products: spot,perp."),
    }),
  ],
  examples: [
    "bun wiggler candles:fill-gaps",
    "bun wiggler candles:fill-gaps --sources coinbase",
    "bun wiggler candles:fill-gaps --assets btc --products spot",
  ],
  output:
    "Per-(source, asset, product) gap counts, missing bars, recovered bars, and elapsed time.",
  sideEffects:
    "Hits Coinbase Advanced Trade and Binance public market data; upserts into the candles table.",
  async run({ io, options }) {
    io.writeStdout(
      `${pc.bold("wiggler candles:fill-gaps")} ${pc.cyan(options.timeframe)}\n`,
    );
    io.writeStdout(
      `${pc.dim("assets:")} ${options.assets.join(",")}  ${pc.dim("sources:")} ${options.sources.join(",")}  ${pc.dim("products:")} ${options.products.join(",")}\n\n`,
    );

    const tasks: FillTask[] = [];
    for (const asset of options.assets) {
      for (const product of options.products) {
        for (const source of options.sources) {
          tasks.push({ asset, product, source });
        }
      }
    }

    const db = createDatabase();
    const results: FillCandleGapsResult[] = [];
    const overallStart = performance.now();

    try {
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < tasks.length) {
          const idx = cursor++;
          const task = tasks[idx];
          if (task === undefined) {
            continue;
          }
          const result = await fillCandleGaps({
            db,
            source: task.source,
            asset: task.asset,
            product: task.product,
            timeframe: options.timeframe,
          });
          results.push(result);
          io.writeStdout(
            `${pc.bold(task.asset.toUpperCase().padEnd(5))} ` +
              `${pc.cyan(task.source.padEnd(8))} ${pc.magenta(task.product.padEnd(4))} ` +
              `${pc.dim("gaps")}=${String(result.gaps.length).padStart(4)} ` +
              `${pc.dim("missing")}=${String(result.missingBars).padStart(5)} ` +
              `${pc.dim("recovered")}=${String(result.recoveredBars).padStart(5)} ` +
              `${pc.dim("elapsed")}=${formatMs(result.elapsedMs)}\n`,
          );
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(fillConcurrency, tasks.length) }, () =>
          worker(),
        ),
      );
    } finally {
      await destroyDatabase(db);
    }

    const overallMs = performance.now() - overallStart;
    const totalMissing = results.reduce((sum, r) => sum + r.missingBars, 0);
    const totalRecovered = results.reduce(
      (sum, r) => sum + r.recoveredBars,
      0,
    );
    io.writeStdout(
      `\n${pc.green("done")}  ${pc.dim("wall=")}${formatMs(overallMs)}  ` +
        `${pc.dim("missing=")}${totalMissing.toLocaleString()}  ` +
        `${pc.dim("recovered=")}${totalRecovered.toLocaleString()}  ` +
        `${pc.dim("series=")}${results.length}\n`,
    );
  },
});

type FillTask = {
  readonly asset: Asset;
  readonly product: Product;
  readonly source: CandleSource;
};

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

function formatMs(ms: number): string {
  if (ms < 1000) {
    return `${ms.toFixed(0)}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(2)}s`;
  }
  return `${Math.floor(ms / 60_000)}m${((ms % 60_000) / 1000).toFixed(0)}s`;
}
