import { readdir } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import { defineCommand } from "@alea/lib/cli/defineCommand";
import { defineFlagOption } from "@alea/lib/cli/defineFlagOption";
import { definePositional } from "@alea/lib/cli/definePositional";
import { openHtmlOnDarwin } from "@alea/lib/exchangePrices/openHtmlOnDarwin";
import { loadReliabilityCapture } from "@alea/lib/reliability/loadReliabilityCapture";
import { writeReliabilityHtml } from "@alea/lib/reliability/writeReliabilityHtml";
import pc from "picocolors";
import { z } from "zod";

const tmpDir = resolvePath(import.meta.dir, "../../../tmp");

export const reliabilityChartCommand = defineCommand({
  name: "reliability:chart",
  summary: "Render the directional agreement dashboard from JSON",
  description:
    "Reads a reliability:capture JSON file and writes the matching standalone HTML dashboard next to it. With no argument, uses the latest reliability_*.json in alea/tmp/.",
  positionals: [
    definePositional({
      key: "jsonPath",
      valueName: "JSON_PATH",
      schema: z
        .string()
        .optional()
        .describe("Path to a reliability_*.json file."),
    }),
  ],
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
    "bun alea reliability:chart",
    "bun alea reliability:chart tmp/reliability_2026-05-04T13-00-00-000Z.json",
  ],
  output: "Prints the path of the rendered HTML file.",
  sideEffects: "Writes one HTML file next to the input JSON.",
  async run({ io, options, positionals }) {
    const jsonPath =
      positionals.jsonPath ??
      (await findLatestReliabilityJson({ dir: tmpDir }));
    if (!jsonPath) {
      throw new Error(
        `no reliability JSON specified and none found in ${tmpDir}.`,
      );
    }
    const payload = await loadReliabilityCapture({ path: jsonPath });
    const htmlPath = jsonPath.replace(/\.json$/, ".html");
    await writeReliabilityHtml({ payload, htmlPath });
    io.writeStdout(`${pc.green("wrote")} ${pc.dim(htmlPath)}\n`);
    if (!options.noOpen) {
      openHtmlOnDarwin({ path: htmlPath });
    }
  },
});

async function findLatestReliabilityJson({
  dir,
}: {
  readonly dir: string;
}): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true });
  const captures = entries
    .filter(
      (entry) => entry.isFile() && /^reliability_.*\.json$/.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
  const newest = captures[captures.length - 1];
  return newest ? resolvePath(dir, newest) : undefined;
}
