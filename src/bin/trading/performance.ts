import { mkdir } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import { env } from "@alea/constants/env";
import { CliUsageError } from "@alea/lib/cli/CliUsageError";
import { defineCommand } from "@alea/lib/cli/defineCommand";
import { defineFlagOption } from "@alea/lib/cli/defineFlagOption";
import { openHtmlOnDarwin } from "@alea/lib/exchangePrices/openHtmlOnDarwin";
import { getPolymarketAuthState } from "@alea/lib/polymarket/getPolymarketClobClient";
import { writeTradingPerformanceArtifacts } from "@alea/lib/trading/performance/writeTradingPerformanceArtifacts";
import { scanPolymarketTradingPerformance } from "@alea/lib/trading/vendor/polymarket/scanTradingPerformance";
import pc from "picocolors";
import { z } from "zod";

const tmpDir = resolvePath(import.meta.dir, "../../../tmp");

export const tradingPerformanceCommand = defineCommand({
  name: "trading:performance",
  summary: "Render a Polymarket trading performance dashboard",
  description:
    "Fetches the configured wallet's full authenticated Polymarket CLOB trade history via getTradesPaginated, fetches each touched CLOB market via getMarket, computes post-fee resolved PnL, and writes a standalone HTML dashboard plus JSON sidecar to alea/tmp/. Polymarket API responses are the only data source.",
  options: [
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
    "bun alea trading:performance",
    "bun alea trading:performance --no-open",
  ],
  output:
    "Prints fetch progress, the resolved post-fee PnL summary, and the paths of the HTML + JSON artifacts.",
  sideEffects:
    "Reads authenticated Polymarket CLOB REST endpoints. Writes one HTML and one JSON file to alea/tmp/. Does not use a database and does not place or cancel orders.",
  async run({ io, options }) {
    if (
      env.polymarketPrivateKey === undefined ||
      env.polymarketFunderAddress === undefined
    ) {
      throw new CliUsageError(
        "POLYMARKET_PRIVATE_KEY and POLYMARKET_FUNDER_ADDRESS must be set.",
      );
    }

    const auth = await getPolymarketAuthState();
    io.writeStdout(
      `${pc.bold("trading:performance")} ${pc.dim("wallet=")}${auth.walletAddress.slice(0, 10)}...\n\n`,
    );

    const payload = await scanPolymarketTradingPerformance({
      client: auth.client,
      walletAddress: auth.walletAddress,
      onProgress: (event) => {
        if (event.kind === "trades-page") {
          io.writeStdout(
            `  ${pc.dim("trades fetched:")} ${event.tradesSoFar}\n`,
          );
        } else {
          io.writeStdout(
            `  ${pc.dim("markets fetched:")} ${event.resolved}/${event.total}\n`,
          );
        }
      },
    });

    await mkdir(tmpDir, { recursive: true });
    const stamp = new Date(payload.generatedAtMs)
      .toISOString()
      .replace(/[:.]/g, "-");
    const htmlPath = resolvePath(tmpDir, `trading-performance_${stamp}.html`);
    const jsonPath = resolvePath(tmpDir, `trading-performance_${stamp}.json`);
    await writeTradingPerformanceArtifacts({ payload, htmlPath, jsonPath });

    io.writeStdout(
      `\n${pc.green("resolved pnl =")} ${formatUsd({ value: payload.summary.lifetimePnlUsd })}\n` +
        `  ${pc.dim("trades:")} ${payload.summary.resolvedTradeCount}/${payload.summary.tradeCount} resolved\n` +
        `  ${pc.dim("markets:")} ${payload.summary.resolvedMarketCount}/${payload.summary.resolvedMarketCount + payload.summary.unresolvedMarketCount} resolved\n` +
        `  ${pc.dim("fees counted:")} ${formatUsd({ value: payload.summary.resolvedFeesUsd, signed: false })}\n` +
        `${pc.green("wrote")} ${pc.dim(jsonPath)}\n` +
        `${pc.green("wrote")} ${pc.dim(htmlPath)}\n`,
    );

    if (!options.noOpen) {
      openHtmlOnDarwin({ path: htmlPath });
    }
  },
});

function formatUsd({
  value,
  signed = true,
}: {
  readonly value: number;
  readonly signed?: boolean;
}): string {
  if (!signed || value === 0) {
    return `$${Math.abs(value).toFixed(2)}`;
  }
  const sign = value > 0 ? "+" : "-";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}
