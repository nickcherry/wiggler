import { mkdir, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import pc from "picocolors";
import { exchangeIdValues } from "@wiggler/constants/exchanges";
import { defineCommand } from "@wiggler/lib/cli/defineCommand";
import { defineFlagOption } from "@wiggler/lib/cli/defineFlagOption";
import { defineValueOption } from "@wiggler/lib/cli/defineValueOption";
import { captureAllQuoteStreams } from "@wiggler/lib/exchangePrices/captureAllQuoteStreams";
import { openHtmlOnDarwin } from "@wiggler/lib/exchangePrices/openHtmlOnDarwin";
import { writePriceChartHtml } from "@wiggler/lib/exchangePrices/writePriceChartHtml";
import { exchangeIdSchema } from "@wiggler/types/exchanges";
import { z } from "zod";

const tmpDir = resolvePath(import.meta.dir, "../../../tmp");

/**
 * Captures top-of-book mid-price ticks from every requested exchange in
 * parallel for a fixed duration, persists the raw ticks to JSON in
 * `wiggler/tmp/`, and writes an interactive HTML chart side-by-side. Both
 * paths are printed; on macOS the chart is opened automatically unless
 * `--no-open` is passed.
 */
export const pricesCaptureCommand = defineCommand({
  name: "prices:capture",
  summary: "Record BBO mid-price ticks across exchanges and chart them",
  description:
    "Opens a public WebSocket to each requested exchange, accumulates every BBO update for the configured duration, then writes a JSON snapshot and an interactive ECharts chart to wiggler/tmp/. Useful for comparing how quickly different venues react to the same price move.",
  options: [
    defineValueOption({
      key: "duration",
      long: "--duration",
      short: "-d",
      valueName: "SECONDS",
      schema: z.coerce
        .number()
        .positive()
        .default(60)
        .describe("Capture window in seconds."),
    }),
    defineValueOption({
      key: "exchanges",
      long: "--exchanges",
      valueName: "LIST",
      schema: z
        .string()
        .optional()
        .transform(parseList)
        .pipe(z.array(exchangeIdSchema).default([...exchangeIdValues]))
        .describe("Comma-separated exchange ids."),
    }),
    defineFlagOption({
      key: "noChart",
      long: "--no-chart",
      schema: z
        .boolean()
        .default(false)
        .describe("Skip writing the HTML chart."),
    }),
    defineFlagOption({
      key: "noOpen",
      long: "--no-open",
      schema: z
        .boolean()
        .default(false)
        .describe("Skip auto-opening the HTML chart on macOS."),
    }),
  ],
  examples: [
    "bun wiggler prices:capture",
    "bun wiggler prices:capture --duration 30",
    "bun wiggler prices:capture --exchanges coinbase-spot,binance-spot,kraken-spot",
    "bun wiggler prices:capture --no-chart",
  ],
  output:
    "Prints per-exchange tick counts, error summary, and the JSON + HTML output paths.",
  sideEffects:
    "Opens public WebSocket connections to each requested exchange and writes files to wiggler/tmp/.",
  async run({ io, options }) {
    const durationMs = Math.round(options.duration * 1000);

    io.writeStdout(
      `${pc.bold("prices:capture")}  ${pc.dim("duration=")}${options.duration}s  ${pc.dim("exchanges=")}${options.exchanges.length}\n`,
    );

    const result = await captureAllQuoteStreams({
      exchanges: options.exchanges,
      durationMs,
      onProgress: (event) => {
        if (event.kind === "open") {
          io.writeStdout(`  ${pc.green("opened")} ${event.exchange}\n`);
        } else if (event.kind === "error") {
          io.writeStdout(
            `  ${pc.red("error")} ${event.exchange}: ${event.error.message}\n`,
          );
        }
      },
    });

    io.writeStdout("\n");
    io.writeStdout(`${pc.bold("Tick counts")}\n`);
    for (const exchange of options.exchanges) {
      const count = result.tickCounts[exchange] ?? 0;
      const color = count > 0 ? pc.green : pc.dim;
      io.writeStdout(
        `  ${exchange.padEnd(16)} ${color(String(count).padStart(6))}\n`,
      );
    }
    io.writeStdout("\n");

    await mkdir(tmpDir, { recursive: true });
    const stamp = new Date(result.startedAtMs)
      .toISOString()
      .replace(/[:.]/g, "-");
    const jsonPath = resolvePath(tmpDir, `prices_${stamp}.json`);
    const htmlPath = resolvePath(tmpDir, `prices_${stamp}.html`);

    await writeFile(jsonPath, JSON.stringify(result, null, 2));
    io.writeStdout(`${pc.green("wrote")} ${pc.dim(jsonPath)}\n`);

    if (!options.noChart) {
      await writePriceChartHtml({ capture: result, htmlPath });
      io.writeStdout(`${pc.green("wrote")} ${pc.dim(htmlPath)}\n`);
      if (!options.noOpen) {
        openHtmlOnDarwin({ path: htmlPath });
      }
    }

    if (result.errors.length > 0) {
      io.writeStdout(`\n${pc.bold("Errors")}\n`);
      for (const { exchange, error } of result.errors) {
        io.writeStdout(`  ${pc.red(exchange)} ${error}\n`);
      }
    }
  },
});

function parseList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const parts = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return parts.length > 0 ? parts : undefined;
}
