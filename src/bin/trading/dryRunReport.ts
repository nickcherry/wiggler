import { mkdir } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import { defineCommand } from "@alea/lib/cli/defineCommand";
import { defineFlagOption } from "@alea/lib/cli/defineFlagOption";
import { defineValueOption } from "@alea/lib/cli/defineValueOption";
import { openHtmlOnDarwin } from "@alea/lib/exchangePrices/openHtmlOnDarwin";
import { loadDryRunReportPayload } from "@alea/lib/trading/dryRun/report/loadDryRunReportPayload";
import { writeDryRunReportArtifacts } from "@alea/lib/trading/dryRun/report/writeDryRunReportArtifacts";
import pc from "picocolors";
import { z } from "zod";

const tmpDir = resolvePath(import.meta.dir, "../../../tmp");
const dryTradingDir = resolvePath(tmpDir, "dry-trading");

export const tradingDryRunReportCommand = defineCommand({
  name: "trading:dry-run-report",
  summary: "Render a dry-trading session dashboard",
  description:
    "Reads one dry-trading JSONL session, defaulting to the newest tmp/dry-trading/dry-trading_*.jsonl file, and writes a standalone Alea-styled HTML dashboard plus JSON sidecar under tmp/. The report focuses on finalized queue-aware fills, filled-versus-placed counterfactuals, absolute placement-distance stats, per-asset/window breakdowns, and the virtual-order ledger.",
  options: [
    defineValueOption({
      key: "session",
      long: "--session",
      valueName: "PATH",
      schema: z
        .string()
        .optional()
        .describe(
          "Dry trading JSONL session to render. Defaults to the newest tmp/dry-trading/dry-trading_*.jsonl.",
        ),
    }),
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
    "bun alea trading:dry-run-report",
    "bun alea trading:dry-run-report --no-open",
    "bun alea trading:dry-run-report --session tmp/dry-trading/dry-trading_2026-05-04T23-50-46.294Z.jsonl",
  ],
  output:
    "Prints the chosen dry-run JSONL session, high-level canonical vs counterfactual metrics, and the HTML + JSON artifact paths.",
  sideEffects:
    "Reads a local dry-trading JSONL file and writes one HTML and one JSON report artifact under alea/tmp/. Does not call network APIs and does not place or cancel orders.",
  async run({ io, options }) {
    const payload = await loadDryRunReportPayload({
      sessionPath: options.session,
      dryTradingDir,
    });
    await mkdir(tmpDir, { recursive: true });
    const stamp = new Date(payload.generatedAtMs)
      .toISOString()
      .replace(/[:.]/g, "-");
    const htmlPath = resolvePath(tmpDir, `dry-trading-report_${stamp}.html`);
    const jsonPath = resolvePath(tmpDir, `dry-trading-report_${stamp}.json`);
    await writeDryRunReportArtifacts({ payload, htmlPath, jsonPath });

    io.writeStdout(
      `${pc.bold("trading:dry-run-report")} ${pc.dim("session=")}${payload.sourcePath}\n\n` +
        `${pc.green("canonical pnl =")} ${formatUsd({ value: payload.summary.canonicalPnlUsd })}\n` +
        `  ${pc.dim("orders:")} ${payload.summary.finalizedOrderCount} finalized analyzed, ${payload.summary.pendingOrderCount} pending excluded\n` +
        `  ${pc.dim("canonical fills:")} ${payload.summary.canonicalFilledCount}/${payload.summary.finalizedOrderCount} (${formatPercent({ value: payload.summary.canonicalFillRate })})\n` +
        `  ${pc.dim("all-filled pnl:")} ${formatUsd({ value: payload.summary.allOrdersFilledPnlUsd })}\n` +
        `  ${pc.dim("actual - all-filled pnl:")} ${formatUsd({ value: payload.summary.fillSelectionDeltaUsd })}\n` +
        `${pc.green("wrote")} ${pc.dim(jsonPath)}\n` +
        `${pc.green("wrote")} ${pc.dim(htmlPath)}\n`,
    );

    if (!options.noOpen) {
      openHtmlOnDarwin({ path: htmlPath });
    }
  },
});

function formatUsd({ value }: { readonly value: number }): string {
  if (value === 0) {
    return "$0.00";
  }
  const sign = value > 0 ? "+" : "-";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function formatPercent({ value }: { readonly value: number | null }): string {
  return value === null ? "--" : `${(value * 100).toFixed(1)}%`;
}
