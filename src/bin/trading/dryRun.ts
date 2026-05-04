import { assetValues } from "@alea/constants/assets";
import { MIN_EDGE } from "@alea/constants/trading";
import { CliUsageError } from "@alea/lib/cli/CliUsageError";
import { defineCommand } from "@alea/lib/cli/defineCommand";
import { defineValueOption } from "@alea/lib/cli/defineValueOption";
import { formatDryRunEvent } from "@alea/lib/trading/dryRun/formatDryRunEvent";
import { runDryRun } from "@alea/lib/trading/dryRun/runDryRun";
import { probabilityTable } from "@alea/lib/trading/probabilityTable/probabilityTable.generated";
import { assetSchema } from "@alea/types/assets";
import pc from "picocolors";
import { z } from "zod";

/**
 * Long-running dry-run trader. No orders are placed and no auth is
 * exercised — the daemon connects to Binance perp BBO + 5m kline
 * streams, polls the Polymarket up/down book, runs the same decision
 * evaluator the live trader will use, and prints what it *would* have
 * done. Designed to be the first thing an operator runs after
 * generating a fresh probability table: a few minutes of clean output
 * proves the wiring before any money goes in.
 */
export const tradingDryRunCommand = defineCommand({
  name: "trading:dry-run",
  summary:
    "Run the live decision pipeline against real feeds without placing orders",
  description:
    "Loads the committed probability table, hydrates EMA-50 from the Binance fapi REST endpoint, opens a single combined-stream WebSocket for bookTicker + kline_5m on every requested asset, polls the Polymarket CLOB book for the current 5m up/down market every 2s, and prints a structured decision line on every minute boundary inside each window. Exits cleanly on SIGINT.",
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
      key: "minEdge",
      long: "--min-edge",
      valueName: "X",
      schema: z.coerce
        .number()
        .min(0)
        .default(MIN_EDGE)
        .describe(
          `Minimum edge over Polymarket bid to mark as TAKE in the log (default ${MIN_EDGE.toFixed(3)}).`,
        ),
    }),
  ],
  examples: [
    "bun alea trading:dry-run",
    "bun alea trading:dry-run --assets btc,eth",
    "bun alea trading:dry-run --min-edge 0.08",
  ],
  output:
    "Streams a one-line-per-event log: boot status, ws/connect cycles, per-minute decisions, per-window summaries.",
  sideEffects:
    "Opens a Binance perp WebSocket; calls fapi.binance.com REST at boot for EMA-50 hydration; polls Polymarket gamma-api and CLOB REST endpoints every few seconds. No orders are placed; no Polymarket auth is exercised.",
  async run({ io, options }) {
    if (probabilityTable.assets.length === 0) {
      throw new CliUsageError(
        "probability table is empty — run `bun alea trading:gen-probability-table` first.",
      );
    }

    const controller = new AbortController();
    const onSigint = () => {
      io.writeStdout("\n");
      io.writeStdout(pc.dim("received SIGINT, shutting down...\n"));
      controller.abort();
    };
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigint);

    try {
      await runDryRun({
        assets: options.assets,
        table: probabilityTable,
        minEdge: options.minEdge,
        signal: controller.signal,
        emit: (event) => {
          io.writeStdout(`${formatDryRunEvent({ event })}\n`);
        },
      });
    } finally {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigint);
    }
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
