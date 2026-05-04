import { assetValues } from "@alea/constants/assets";
import { MIN_EDGE } from "@alea/constants/trading";
import { CliUsageError } from "@alea/lib/cli/CliUsageError";
import { defineCommand } from "@alea/lib/cli/defineCommand";
import { defineValueOption } from "@alea/lib/cli/defineValueOption";
import { formatDryRunEvent } from "@alea/lib/trading/dryRun/formatDryRunEvent";
import { runDryRun } from "@alea/lib/trading/dryRun/runDryRun";
import { probabilityTable } from "@alea/lib/trading/probabilityTable/probabilityTable.generated";
import { createPolymarketVendor } from "@alea/lib/trading/vendor/polymarket/createPolymarketVendor";
import { assetSchema } from "@alea/types/assets";
import pc from "picocolors";
import { z } from "zod";

/**
 * Long-running dry trader. No orders are placed and no auth is
 * exercised. The daemon connects to the same live price source as the
 * live trader, discovers current Polymarket markets, subscribes to the
 * public market-data websocket, prepares virtual maker orders through
 * the vendor order-prep path, and simulates queue-aware fills.
 */
export const tradingDryRunCommand = defineCommand({
  name: "trading:dry-run",
  summary:
    "Simulate live trading against real feeds without placing orders",
  description:
    "Loads the committed probability table, hydrates moving trackers from the configured live price source, opens live price and Polymarket public market-data websockets, runs the same decision and maker-order preparation path as trading:live, and simulates queue-aware fills instead of signing or posting orders. Appends JSONL session/window records under tmp/dry-trading/ and exits cleanly on SIGINT.",
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
    "Streams a one-line-per-event log: boot status, ws/connect cycles, per-minute decisions, virtual orders/fills, and finalized dry-window summaries. Writes a timestamped JSONL session log under tmp/dry-trading/.",
  sideEffects:
    "Opens live price and Polymarket public market-data WebSockets; calls price-source REST at boot and settlement; polls Polymarket gamma-api/CLOB read endpoints; appends JSONL files under alea/tmp/dry-trading/. No orders are placed, cancelled, signed, or authenticated.",
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
      const vendor = await createPolymarketVendor();
      await runDryRun({
        vendor,
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
