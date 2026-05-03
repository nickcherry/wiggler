import { assetValues } from "@wiggler/constants/assets";
import {
  candleTimeframeValues,
  defaultCandleLookbackDays,
} from "@wiggler/constants/candles";
import { candleSourceValues } from "@wiggler/constants/sources";
import { alignTimeframeWindow } from "@wiggler/lib/candles/alignTimeframeWindow";
import { summarizeSyncResult } from "@wiggler/lib/candles/summarizeSyncResult";
import { syncCandles, type SyncCandlesResult } from "@wiggler/lib/candles/syncCandles";
import { defineCommand } from "@wiggler/lib/cli/defineCommand";
import { defineValueOption } from "@wiggler/lib/cli/defineValueOption";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import { assetSchema } from "@wiggler/types/assets";
import { candleTimeframeSchema } from "@wiggler/types/candles";
import { candleSourceSchema } from "@wiggler/types/sources";
import pc from "picocolors";
import { z } from "zod";

const millisecondsPerDay = 86_400_000;

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
  ],
  examples: [
    "bun wiggler candles:sync",
    "bun wiggler candles:sync --timeframe 5m --days 730",
    "bun wiggler candles:sync --assets btc,eth --sources binance",
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
      `${pc.bold("wiggler candles:sync")} ${pc.cyan(options.timeframe)} ${pc.dim(start.toISOString())} → ${pc.dim(end.toISOString())}\n`,
    );
    io.writeStdout(
      `${pc.dim("assets:")} ${options.assets.join(",")}  ${pc.dim("sources:")} ${options.sources.join(",")}\n\n`,
    );

    const db = createDatabase();
    const results: SyncCandlesResult[] = [];
    const overallStart = performance.now();

    try {
      for (const asset of options.assets) {
        io.writeStdout(pc.bold(asset.toUpperCase()) + "\n");
        for (const source of options.sources) {
          const result = await syncCandles({
            db,
            source,
            asset,
            timeframe: options.timeframe,
            start,
            end,
          });
          results.push(result);
          const stats = summarizeSyncResult({ result });
          io.writeStdout(
            `  ${pc.cyan(source.padEnd(8))} ` +
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
        io.writeStdout("\n");
      }
    } finally {
      await destroyDatabase(db);
    }

    const overallMs = performance.now() - overallStart;
    const totalRows = results.reduce((sum, r) => sum + r.fetched, 0);
    io.writeStdout(
      `${pc.green("done")}  ${pc.dim("wall=")}${formatMs(overallMs)}  ${pc.dim("rows=")}${totalRows.toLocaleString()}  ${pc.dim("series=")}${results.length}\n`,
    );
  },
});

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
  if (ms < 1000) {return `${ms.toFixed(0)}ms`;}
  if (ms < 60_000) {return `${(ms / 1000).toFixed(2)}s`;}
  return `${Math.floor(ms / 60_000)}m${((ms % 60_000) / 1000).toFixed(0)}s`;
}
