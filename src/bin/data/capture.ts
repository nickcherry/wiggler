import { resolve as resolvePath } from "node:path";

import { assetValues } from "@alea/constants/assets";
import { defineCommand } from "@alea/lib/cli/defineCommand";
import { defineFlagOption } from "@alea/lib/cli/defineFlagOption";
import { defineValueOption } from "@alea/lib/cli/defineValueOption";
import { createDatabase } from "@alea/lib/db/createDatabase";
import { destroyDatabase } from "@alea/lib/db/destroyDatabase";
import {
  type CaptureLogEvent,
  defaultCaptureDir,
  runCapture,
} from "@alea/lib/marketCapture/runCapture";
import { assetSchema } from "@alea/types/assets";
import pc from "picocolors";
import { z } from "zod";

const repoRoot = resolvePath(import.meta.dir, "../../..");

/**
 * Long-running market-data capture.
 *
 * Subscribes to the same Polymarket up/down 5m WS the dry-run trader
 * uses, plus the Binance USDT-M perpetual BBO + 5m kline WS for the
 * configured asset set, and writes every event to a per-window JSONL
 * file under `tmp/market-capture/YYYY-MM-DD/<windowKey>.jsonl`. On
 * each 5-minute boundary the previous file is closed and (unless
 * `--no-ingest` is passed) bulk-loaded into the `market_event` table.
 *
 * Designed to run for days without intervention. Recovery on restart
 * picks up any orphaned `.jsonl` files in the capture directory and
 * loads them before the new window's writer opens.
 */
export const dataCaptureCommand = defineCommand({
  name: "data:capture",
  summary:
    "Long-running capture of Polymarket + Binance + Coinbase + Chainlink market-data events to disk and Postgres",
  description:
    "Opens the Polymarket public market-data WS for current/next-window up/down 5m markets, the Binance USDT-M perp BBO+kline WS, the Coinbase Advanced Trade level2 channel for both <asset>-USD spot and <asset>-PERP-INTX perp, and Polymarket's RTDS Chainlink reference-price topic — all for the configured asset set. Writes each event as one JSONL line under tmp/market-capture/, rotating files at the 5-minute window boundary. Successfully rotated files are bulk-loaded into the market_event Postgres table. On startup, recovers and loads any orphaned .jsonl files from prior runs. Exits cleanly on SIGINT/SIGTERM.",
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
      key: "dir",
      long: "--dir",
      valueName: "PATH",
      schema: z
        .string()
        .optional()
        .describe(
          "Override the capture directory (default tmp/market-capture under the repo root).",
        ),
    }),
    defineFlagOption({
      key: "noIngest",
      long: "--no-ingest",
      schema: z
        .boolean()
        .default(false)
        .describe(
          "Do not load rotated JSONLs into Postgres. JSONLs still rotate at window boundaries; the operator can ingest them later via data:ingest-pending. Useful for the first calibration run.",
        ),
    }),
  ],
  examples: [
    "bun alea data:capture",
    "bun alea data:capture --assets btc,eth",
    "bun alea data:capture --no-ingest",
  ],
  output:
    "Streams one log line per state change (rotation, recovered session, ingest result, ws connect/disconnect/error). The JSONL tape itself is the primary artifact — stdout is operator visibility only.",
  sideEffects:
    "Opens Polymarket, Binance, and Coinbase WebSockets plus the Polymarket-RTDS Chainlink stream; calls Polymarket gamma-api/CLOB read endpoints to discover markets each window; writes JSONL files under tmp/market-capture/ (or the directory passed to --dir); inserts rows into the market_event Postgres table unless --no-ingest is set.",
  async run({ io, options }) {
    const dir = options.dir ?? defaultCaptureDir({ repoRoot });
    const ingest = !options.noIngest;

    io.writeStdout(
      `${pc.bold("data:capture")}  ${pc.dim("assets=")}${options.assets.join(",")}  ${pc.dim("dir=")}${dir}  ${pc.dim("ingest=")}${ingest}\n`,
    );

    const controller = new AbortController();
    const onSignal = (signalName: string) => () => {
      io.writeStdout(
        `\n${pc.dim(`received ${signalName}, shutting down...`)}\n`,
      );
      controller.abort();
    };
    const onSigint = onSignal("SIGINT");
    const onSigterm = onSignal("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);

    const db = createDatabase();

    try {
      await runCapture({
        db,
        assets: options.assets,
        dir,
        signal: controller.signal,
        ingest,
        log: (event) => {
          io.writeStdout(`${formatLog(event)}\n`);
        },
      });
    } finally {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      await destroyDatabase(db);
    }
  },
});

function formatLog(event: CaptureLogEvent): string {
  const ts = new Date(event.atMs).toISOString().slice(11, 19);
  const tag =
    event.kind === "error"
      ? pc.red("ERR")
      : event.kind === "warn"
        ? pc.yellow("WRN")
        : pc.dim("INF");
  return `${pc.dim(ts)} ${tag} ${event.message}`;
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
