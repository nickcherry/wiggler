import { readdir } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import pc from "picocolors";
import { defineCommand } from "@wiggler/lib/cli/defineCommand";
import { defineFlagOption } from "@wiggler/lib/cli/defineFlagOption";
import { definePositional } from "@wiggler/lib/cli/definePositional";
import { loadQuoteCapture } from "@wiggler/lib/exchangePrices/loadQuoteCapture";
import { openHtmlOnDarwin } from "@wiggler/lib/exchangePrices/openHtmlOnDarwin";
import { writePriceChartHtml } from "@wiggler/lib/exchangePrices/writePriceChartHtml";
import { z } from "zod";

const tmpDir = resolvePath(import.meta.dir, "../../../tmp");

/**
 * Re-renders an HTML chart from a saved `prices:capture` JSON file. Useful
 * after iterating on the chart renderer or when an old capture should be
 * re-styled with the latest visualization.
 *
 * If no path is supplied, the most recently modified `prices_*.json` in
 * `wiggler/tmp/` is used.
 */
export const pricesChartCommand = defineCommand({
  name: "prices:chart",
  summary: "Re-render the HTML chart from a saved capture JSON",
  description:
    "Reads a `prices:capture` JSON snapshot and writes a fresh HTML chart next to it. With no argument, picks the most recently modified `prices_*.json` in wiggler/tmp/.",
  positionals: [
    definePositional({
      key: "jsonPath",
      valueName: "JSON_PATH",
      schema: z
        .string()
        .optional()
        .describe(
          "Path to a prices_*.json file. Defaults to the latest in wiggler/tmp/.",
        ),
    }),
  ],
  options: [
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
    "bun wiggler prices:chart",
    "bun wiggler prices:chart tmp/prices_2026-05-02T22-59-19-835Z.json",
    "bun wiggler prices:chart --no-open tmp/prices_2026-05-02T22-59-19-835Z.json",
  ],
  output: "Prints the path of the rendered HTML file.",
  sideEffects: "Writes one HTML file next to the input JSON.",
  async run({ io, options, positionals }) {
    const jsonPath =
      positionals.jsonPath ?? (await findLatestCaptureJson({ dir: tmpDir }));
    if (!jsonPath) {
      throw new Error(
        `no capture JSON specified and none found in ${tmpDir}.`,
      );
    }

    const capture = await loadQuoteCapture({ path: jsonPath });
    const htmlPath = jsonPath.replace(/\.json$/, ".html");
    await writePriceChartHtml({ capture, htmlPath });

    io.writeStdout(`${pc.green("wrote")} ${pc.dim(htmlPath)}\n`);
    if (!options.noOpen) {
      openHtmlOnDarwin({ path: htmlPath });
    }
  },
});

async function findLatestCaptureJson({
  dir,
}: {
  readonly dir: string;
}): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true });
  const captures = entries
    .filter((entry) => entry.isFile() && /^prices_.*\.json$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const newest = captures[captures.length - 1];
  return newest ? resolvePath(dir, newest) : undefined;
}
