import { env } from "@alea/constants/env";
import { CliUsageError } from "@alea/lib/cli/CliUsageError";
import { defineCommand } from "@alea/lib/cli/defineCommand";
import {
  DEFAULT_LIFETIME_PNL_PATH,
  persistLifetimePnl,
} from "@alea/lib/trading/state/lifetimePnlStore";
import { createPolymarketVendor } from "@alea/lib/trading/vendor/polymarket/createPolymarketVendor";
import pc from "picocolors";

/**
 * Manually rescans the wallet's full vendor trade history, computes
 * lifetime PnL from scratch, and overwrites the on-disk checkpoint.
 * The live runner does this automatically on cold start; this command
 * is the operator's escape hatch when the checkpoint feels stale or
 * after manual trades on the wallet outside the bot.
 *
 * Read-only against the venue. Does not place or cancel any orders.
 */
export const tradingHydrateLifetimePnlCommand = defineCommand({
  name: "trading:hydrate-lifetime-pnl",
  summary:
    "Rescan the wallet's full Polymarket trade history and refresh the lifetime PnL checkpoint",
  description:
    "Pulls every fill on the configured Polymarket wallet via paginated getTradesPaginated, fetches each unique market's resolution via getMarket (concurrency 10), sums realized PnL per market, and writes the result to tmp/lifetime-pnl.json. Required when the on-disk checkpoint was deleted, became corrupt, or has drifted from reality due to manual trading on the wallet outside the bot.",
  options: [],
  examples: ["bun alea trading:hydrate-lifetime-pnl"],
  output:
    "Per-step progress (trades fetched, markets resolved), the final lifetime PnL, and the path of the refreshed checkpoint file.",
  sideEffects:
    "Reads from Polymarket REST endpoints. OVERWRITES tmp/lifetime-pnl.json. Does not place or cancel any orders.",
  async run({ io }) {
    if (
      env.polymarketPrivateKey === undefined ||
      env.polymarketFunderAddress === undefined
    ) {
      throw new CliUsageError(
        "POLYMARKET_PRIVATE_KEY and POLYMARKET_FUNDER_ADDRESS must be set.",
      );
    }
    const vendor = await createPolymarketVendor();
    io.writeStdout(
      `${pc.bold("trading:hydrate-lifetime-pnl")} ${pc.dim(`(vendor=${vendor.id} wallet=`)}${vendor.walletAddress.slice(0, 10)}…${pc.dim(")")}\n`,
    );
    const scan = await vendor.scanLifetimePnl({
      onProgress: (event) => {
        if (event.kind === "trades-page") {
          io.writeStdout(
            `  ${pc.dim("trades fetched:")} ${event.tradesSoFar}\n`,
          );
        } else {
          io.writeStdout(
            `  ${pc.dim("markets resolved:")} ${event.resolved}/${event.total}\n`,
          );
        }
      },
    });
    await persistLifetimePnl({
      walletAddress: vendor.walletAddress,
      lifetimePnlUsd: scan.lifetimePnlUsd,
    });
    io.writeStdout(
      `\n${pc.green("lifetime pnl =")} ${formatUsd({ value: scan.lifetimePnlUsd })}\n` +
        `  ${pc.dim("resolved markets counted:")} ${scan.resolvedMarketsCounted}\n` +
        `  ${pc.dim("unresolved markets skipped:")} ${scan.unresolvedMarketsSkipped}\n` +
        `  ${pc.dim("trades counted:")} ${scan.tradesCounted}\n` +
        `${pc.green("wrote")} ${pc.dim(DEFAULT_LIFETIME_PNL_PATH)}\n`,
    );
  },
});

function formatUsd({ value }: { readonly value: number }): string {
  if (value === 0) {
    return "$0.00";
  }
  const sign = value > 0 ? "+" : "-";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}
