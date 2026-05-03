import { assetValues } from "@alea/constants/assets";
import {
  candleTimeframeValues,
  defaultCandleLookbackDays,
} from "@alea/constants/candles";
import { productValues } from "@alea/constants/products";
import { candleSourceValues } from "@alea/constants/sources";
import { alignTimeframeWindow } from "@alea/lib/candles/alignTimeframeWindow";
import { summarizeSyncResult } from "@alea/lib/candles/summarizeSyncResult";
import {
  syncCandles,
  type SyncCandlesResult,
} from "@alea/lib/candles/syncCandles";
import { defineCommand } from "@alea/lib/cli/defineCommand";
import { defineValueOption } from "@alea/lib/cli/defineValueOption";
import { createDatabase } from "@alea/lib/db/createDatabase";
import { destroyDatabase } from "@alea/lib/db/destroyDatabase";
import type { Asset } from "@alea/types/assets";
import { assetSchema } from "@alea/types/assets";
import { candleTimeframeSchema } from "@alea/types/candles";
import type { Product } from "@alea/types/products";
import { productSchema } from "@alea/types/products";
import type { CandleSource } from "@alea/types/sources";
import { candleSourceSchema } from "@alea/types/sources";
import pc from "picocolors";
import { z } from "zod";

const millisecondsPerDay = 86_400_000;

/**
 * Concurrent series in flight. Sized so each provider sees at most half the
 * load when the iteration order alternates Coinbase / Binance evenly — four
 * workers across two providers means roughly two concurrent requests per
 * provider, which stays comfortably below either's public rate limits.
 */
const syncConcurrency = 4;

/**
 * Backfills 5-minute (or 1-minute) candles into Postgres for a configurable
 * window, asset list, and source list.
 */
export const candlesSyncCommand = defineCommand({
  name: "candles:sync",
  summary: "Backfill candles into Postgres",
  description:
    "Page through the historical candle window for each (source, asset) and upsert into the local Postgres database. Per-page latency is recorded so slow pages stay visible.",
  options: [
    defineValueOption({
      key: "timeframe",
      long: "--timeframe",
      short: "-t",
      valueName: "TIMEFRAME",
      choices: candleTimeframeValues,
      schema: candleTimeframeSchema
        .default("5m")
        .describe("Candle timeframe to fetch."),
    }),
    defineValueOption({
      key: "days",
      long: "--days",
      valueName: "N",
      schema: z.coerce
        .number()
        .int()
        .positive()
        .default(defaultCandleLookbackDays)
        .describe("Lookback window in days."),
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
    "bun alea candles:sync",
    "bun alea candles:sync --timeframe 5m --days 730",
    "bun alea candles:sync --assets btc,eth --sources binance",
    "bun alea candles:sync --products spot",
  ],
  output:
    "Prints per-(source, asset) row counts and page-latency stats, then the overall total.",
  sideEffects:
    "Hits Coinbase Advanced Trade and Binance public market data; upserts into the candles table.",
  async run({ io, options }) {
    const end = alignTimeframeWindow({
      date: new Date(),
      timeframe: options.timeframe,
    });
    const start = new Date(end.getTime() - options.days * millisecondsPerDay);

    io.writeStdout(
      `${pc.bold("alea candles:sync")} ${pc.cyan(options.timeframe)} ${pc.dim(start.toISOString())} → ${pc.dim(end.toISOString())}\n`,
    );
    io.writeStdout(
      `${pc.dim("assets:")} ${options.assets.join(",")}  ${pc.dim("sources:")} ${options.sources.join(",")}  ${pc.dim("products:")} ${options.products.join(",")}\n\n`,
    );

    const db = createDatabase();
    const results: SyncCandlesResult[] = [];
    const overallStart = performance.now();

    // Iterate `asset → product → source` so the queue alternates providers
    // every other task. With concurrency 8 that lands ~4 requests on each
    // provider at any moment — well below both Coinbase Advanced Trade's and
    // Binance Vision's public rate limits.
    const tasks: SyncTask[] = [];
    for (const asset of options.assets) {
      for (const product of options.products) {
        for (const source of options.sources) {
          tasks.push({ asset, product, source });
        }
      }
    }

    try {
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < tasks.length) {
          const idx = cursor++;
          const task = tasks[idx];
          if (task === undefined) {
            continue;
          }
          const result = await syncCandles({
            db,
            source: task.source,
            asset: task.asset,
            product: task.product,
            timeframe: options.timeframe,
            start,
            end,
          });
          results.push(result);
          const stats = summarizeSyncResult({ result });
          io.writeStdout(
            `${pc.bold(task.asset.toUpperCase().padEnd(5))} ` +
              `${pc.cyan(task.source.padEnd(8))} ${pc.magenta(task.product.padEnd(4))} ` +
              `${pc.dim("pages")}=${String(stats.count).padStart(4)} ` +
              `${pc.dim("rows")}=${String(result.fetched).padStart(8)} ` +
              `${pc.dim("fetch")}=${formatMs(result.fetchTotalMs).padStart(8)} ` +
              `${pc.dim("mean")}=${formatMs(stats.meanMs)} ` +
              `${pc.dim("p50")}=${formatMs(stats.p50Ms)} ` +
              `${pc.dim("p95")}=${formatMs(stats.p95Ms)} ` +
              `${pc.dim("max")}=${formatMs(stats.maxMs)} ` +
              `${pc.dim("upsert")}=${formatMs(result.upsertTotalMs)}\n`,
          );
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(syncConcurrency, tasks.length) }, () =>
          worker(),
        ),
      );
    } finally {
      await destroyDatabase(db);
    }

    const overallMs = performance.now() - overallStart;
    const totalRows = results.reduce((sum, r) => sum + r.fetched, 0);
    io.writeStdout(
      `\n${pc.green("done")}  ${pc.dim("wall=")}${formatMs(overallMs)}  ${pc.dim("rows=")}${totalRows.toLocaleString()}  ${pc.dim("series=")}${results.length}\n`,
    );
  },
});

type SyncTask = {
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
