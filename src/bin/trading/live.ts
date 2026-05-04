import { assetValues } from "@alea/constants/assets";
import { env } from "@alea/constants/env";
import { MIN_EDGE, STAKE_USD } from "@alea/constants/trading";
import { CliUsageError } from "@alea/lib/cli/CliUsageError";
import { defineCommand } from "@alea/lib/cli/defineCommand";
import { defineFlagOption } from "@alea/lib/cli/defineFlagOption";
import { defineValueOption } from "@alea/lib/cli/defineValueOption";
import { runLive } from "@alea/lib/trading/live/runLive";
import type { LiveEvent } from "@alea/lib/trading/live/types";
import { probabilityTable } from "@alea/lib/trading/probabilityTable/probabilityTable.generated";
import { createPolymarketVendor } from "@alea/lib/trading/vendor/polymarket/createPolymarketVendor";
import { assetSchema } from "@alea/types/assets";
import pc from "picocolors";
import { z } from "zod";

/**
 * Live, money-touching trader. Connects the same decision pipeline the
 * dry-run uses, but actually places maker-only limit BUY orders on
 * Polymarket, watches fills via the user WS channel, settles each
 * window with real PnL net of fees, and ships a per-window summary
 * over Telegram.
 *
 * The command is a long-running daemon. Exit cleanly on SIGINT.
 *
 * Confirmation gate: by default this command prints what it would do
 * and exits without placing any order — explicit `--commit` is
 * required to actually trade. The dry-run command (`trading:dry-run`)
 * stays the recommended way to inspect signals; `--commit` here is for
 * when you've already done that and want to send orders.
 */
export const tradingLiveCommand = defineCommand({
  name: "trading:live",
  summary:
    "Run the live trader (maker-only limit orders, real money). Requires --commit.",
  description:
    "Hydrates EMA-50 from Binance, opens the Binance perp WS, opens the Polymarket user WS, evaluates the same decision pipeline trading:dry-run uses, and posts maker-only GTD limit BUY orders ($STAKE_USD per trade) on the side with the largest edge over the current Polymarket bid. Orders use venue tick/min-size constraints and expire before window close, with cancel as a backup. Settles filled positions on the kline_5m close and ships a per-window Telegram summary including REAL PnL net of fees. In-memory state only; Polymarket is the source of truth and the runner re-hydrates from getOpenOrders + getTrades on every market discovery.",
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
          `Minimum edge over the Polymarket bid before a trade is placed (default ${MIN_EDGE.toFixed(3)}).`,
        ),
    }),
    defineFlagOption({
      key: "commit",
      long: "--commit",
      schema: z
        .boolean()
        .default(false)
        .describe(
          "Required to actually place orders. Without this flag the command refuses to start; use trading:dry-run for what-if logs.",
        ),
    }),
  ],
  examples: [
    "bun alea trading:live --commit",
    "bun alea trading:live --commit --assets btc",
    "bun alea trading:live --commit --min-edge 0.08",
  ],
  output:
    "Streams a one-line-per-event log: boot, ws connects/disconnects, decisions, order placements, fills, and per-window summaries.",
  sideEffects:
    "Posts maker-only GTD limit BUY orders on Polymarket for matched (side, edge) signals. Sends Telegram messages on every order placement and once per window summary. Reads from fapi.binance.com (REST + WS) and Polymarket (gamma-api, CLOB REST + WS).",
  async run({ io, options }) {
    if (probabilityTable.assets.length === 0) {
      throw new CliUsageError(
        "probability table is empty — run `bun alea trading:gen-probability-table` first.",
      );
    }
    if (!options.commit) {
      throw new CliUsageError(
        "trading:live requires --commit to actually place orders. Use `bun alea trading:dry-run` for what-if logging without orders.",
      );
    }
    const telegramBotToken = env.telegramBotToken;
    const telegramChatId = env.telegramChatId;
    if (telegramBotToken === undefined || telegramChatId === undefined) {
      throw new CliUsageError(
        "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set; the live trader sends placement and window-summary alerts on every cycle.",
      );
    }
    if (
      env.polymarketPrivateKey === undefined ||
      env.polymarketFunderAddress === undefined
    ) {
      throw new CliUsageError(
        "POLYMARKET_PRIVATE_KEY and POLYMARKET_FUNDER_ADDRESS must be set.",
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

    io.writeStdout(
      `${pc.bold("trading:live")} ${pc.dim("(commit)")} starting; stake=$${STAKE_USD} minEdge=${options.minEdge.toFixed(3)} assets=${options.assets.join(",")}\n`,
    );

    try {
      const vendor = await createPolymarketVendor({ eagerAuth: true });
      await runLive({
        vendor,
        assets: options.assets,
        table: probabilityTable,
        minEdge: options.minEdge,
        telegramBotToken,
        telegramChatId,
        signal: controller.signal,
        emit: (event) => {
          io.writeStdout(`${formatLiveEvent({ event })}\n`);
        },
      });
    } finally {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigint);
    }
  },
});

function formatLiveEvent({ event }: { readonly event: LiveEvent }): string {
  const ts = pc.dim(new Date(event.atMs).toISOString().slice(11, 19));
  switch (event.kind) {
    case "info":
      return `${ts} ${event.message}`;
    case "warn":
      return `${ts} ${pc.yellow(event.message)}`;
    case "error":
      return `${ts} ${pc.red(event.message)}`;
    case "decision": {
      const { decision } = event;
      if (decision.kind === "trade") {
        const s = decision.snapshot;
        return `${ts} ${pc.bold(s.asset.toUpperCase().padEnd(5))} ${pc.dim(`[rem=${s.remaining}m]`)} ${s.distanceBp}bp ${s.aligned ? pc.cyan("aligned") : pc.dim("vs-regime")} ourP=${decision.chosen.ourProbability.toFixed(3)} ${pc.green(`→ TAKE ${decision.chosen.side.toUpperCase()} @${decision.chosen.bid?.toFixed(2) ?? "?"} edge=${formatSigned({ value: decision.chosen.edge ?? 0 })}`)}`;
      }
      if (decision.snapshot === null) {
        return `${ts} ${pc.dim(decision.reason.toUpperCase())}`;
      }
      const s = decision.snapshot;
      return `${ts} ${pc.bold(s.asset.toUpperCase().padEnd(5))} ${pc.dim(`[rem=${s.remaining}m]`)} ${s.distanceBp}bp ${s.aligned ? pc.cyan("aligned") : pc.dim("vs-regime")} ${pc.yellow(`→ SKIP ${decision.reason}`)}`;
    }
    case "order-placed":
      return `${ts} ${pc.green("ORDER PLACED")} ${pc.bold(event.asset.toUpperCase().padEnd(5))} ${event.slot.side.toUpperCase()} @${event.slot.limitPrice.toFixed(2)} order=${event.slot.orderId?.slice(0, 12) ?? "?"}…`;
    case "fill":
      return `${ts} ${pc.green("FILL")} ${pc.bold(event.asset.toUpperCase().padEnd(5))} ${event.slot.side.toUpperCase()} shares=${event.slot.sharesFilled.toFixed(2)} cost=$${event.slot.costUsd.toFixed(2)}${event.slot.orderId === null ? " (order fully filled)" : ""}`;
    case "window-summary": {
      const start = new Date(event.windowStartMs).toISOString().slice(11, 16);
      const end = new Date(event.windowEndMs).toISOString().slice(11, 16);
      return `${ts} ${pc.bold(`=== window ${start} → ${end} ===`)}\n${event.body}`;
    }
  }
}

function formatSigned({ value }: { readonly value: number }): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(3)}`;
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
