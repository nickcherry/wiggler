import { mkdir, readdir } from "node:fs/promises";
import { basename, resolve as resolvePath } from "node:path";

import { assetValues } from "@alea/constants/assets";
import { defineCommand } from "@alea/lib/cli/defineCommand";
import { defineFlagOption } from "@alea/lib/cli/defineFlagOption";
import { defineValueOption } from "@alea/lib/cli/defineValueOption";
import { openHtmlOnDarwin } from "@alea/lib/exchangePrices/openHtmlOnDarwin";
import { formatReliabilityWindow } from "@alea/lib/reliability/formatReliabilityWindow";
import { loadReliabilityCapture } from "@alea/lib/reliability/loadReliabilityCapture";
import { runReliabilityCapture } from "@alea/lib/reliability/runReliabilityCapture";
import type { ReliabilityCapturePayload } from "@alea/lib/reliability/types";
import { writeReliabilityCapture } from "@alea/lib/reliability/writeReliabilityCapture";
import { writeReliabilityHtml } from "@alea/lib/reliability/writeReliabilityHtml";
import { type Asset, assetSchema } from "@alea/types/assets";
import pc from "picocolors";
import { z } from "zod";

const tmpDir = resolvePath(import.meta.dir, "../../../tmp");
const DEFAULT_DURATION_SECONDS = 3_600;
const DEFAULT_GRACE_MS = 10_000;
const DEFAULT_NEAR_ZERO_BP = 1;

export const reliabilityCaptureCommand = defineCommand({
  name: "reliability:capture",
  summary: "Compare directional outcomes across exchange feeds",
  description:
    "Opens multi-asset quote streams for Coinbase spot/perp, Binance spot/perp, and Polymarket Chainlink RTDS. It skips the partial startup window, captures full 5-minute windows, and records whether each source's own start-to-end direction agrees with Polymarket's baseline.",
  options: [
    defineValueOption({
      key: "duration",
      long: "--duration",
      short: "-d",
      valueName: "SECONDS",
      schema: z.coerce
        .number()
        .positive()
        .default(DEFAULT_DURATION_SECONDS)
        .describe("Requested full-window capture duration in seconds."),
    }),
    defineValueOption({
      key: "assets",
      long: "--assets",
      valueName: "LIST",
      schema: z
        .string()
        .optional()
        .transform(parseList)
        .pipe(z.array(assetSchema).default([...assetValues]))
        .describe("Comma-separated asset list (default: repo whitelist)."),
    }),
    defineValueOption({
      key: "graceMs",
      long: "--grace-ms",
      valueName: "MS",
      schema: z.coerce
        .number()
        .int()
        .nonnegative()
        .default(DEFAULT_GRACE_MS)
        .describe("Max lag after a 5m boundary before an end tick is missing."),
    }),
    defineValueOption({
      key: "nearZeroBp",
      long: "--near-zero-bp",
      valueName: "BP",
      schema: z.coerce
        .number()
        .int()
        .nonnegative()
        .default(DEFAULT_NEAR_ZERO_BP)
        .describe("Baseline delta threshold counted as near-zero movement."),
    }),
    defineFlagOption({
      key: "indefinite",
      long: "--indefinite",
      schema: z
        .boolean()
        .default(false)
        .describe("Run until SIGINT/SIGTERM instead of stopping by duration."),
    }),
    defineValueOption({
      key: "resume",
      long: "--resume",
      valueName: "JSON_PATH",
      schema: z
        .string()
        .optional()
        .describe("Append to a specific reliability capture JSON file."),
    }),
    defineFlagOption({
      key: "fresh",
      long: "--fresh",
      schema: z
        .boolean()
        .default(false)
        .describe("Start a new reliability capture file instead of resuming."),
    }),
    defineFlagOption({
      key: "noChart",
      long: "--no-chart",
      schema: z
        .boolean()
        .default(false)
        .describe("Skip writing the HTML view."),
    }),
    defineFlagOption({
      key: "noOpen",
      long: "--no-open",
      schema: z
        .boolean()
        .default(false)
        .describe("Skip auto-opening the HTML view on macOS."),
    }),
  ],
  examples: [
    "bun alea reliability:capture",
    "bun alea reliability:capture --indefinite",
    "bun alea reliability:capture --duration 3600 --assets btc,eth,sol,xrp,doge",
    "bun alea reliability:capture --resume tmp/reliability_2026-05-04T13-00-00-000Z.json",
    "bun alea reliability:capture --fresh",
    "bun alea reliability:capture --duration 900 --no-open",
  ],
  output:
    "Prints source connection events and a compact per-window agreement table. Writes JSON incrementally and optionally writes an HTML dashboard.",
  sideEffects:
    "Opens public WebSocket connections, calls Polymarket gamma-api once per asset/window, and writes reliability_*.json/html under alea/tmp/.",
  async run({ io, options }) {
    await mkdir(tmpDir, { recursive: true });
    if (options.fresh && options.resume !== undefined) {
      throw new Error("--fresh and --resume cannot be used together.");
    }
    const resumed = options.fresh
      ? null
      : await resolveResumeCapture({
          assets: options.assets,
          resumePath: options.resume,
        });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const jsonPath =
      resumed?.path ?? resolvePath(tmpDir, `reliability_${stamp}.json`);
    const htmlPath = jsonPath.replace(/\.json$/, ".html");

    io.writeStdout(
      `${pc.bold("reliability:capture")}  ${pc.dim("duration=")}${options.indefinite ? "indefinite" : `${options.duration}s`}  ${pc.dim("assets=")}${options.assets.join(",")}  ${pc.dim("json=")}${jsonPath}\n`,
    );
    if (resumed !== null) {
      io.writeStdout(
        `${pc.dim("resuming=")}${basename(resumed.path)} ${pc.dim("completed=")}${resumed.payload.completedWindows.length} asset-windows\n`,
      );
    }

    const controller = new AbortController();
    const onSignal = () => {
      io.writeStdout("\n");
      io.writeStdout(pc.dim("received shutdown signal, stopping capture...\n"));
      controller.abort();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    try {
      const payload = await runReliabilityCapture({
        assets: options.assets,
        durationMs: options.indefinite
          ? null
          : Math.round(options.duration * 1000),
        graceMs: options.graceMs,
        nearZeroThresholdBp: options.nearZeroBp,
        resumeFrom: resumed?.payload,
        signal: controller.signal,
        persist: (capture) =>
          writeReliabilityCapture({ path: jsonPath, capture }),
        emit: (event) => {
          switch (event.kind) {
            case "info":
              io.writeStdout(
                `${pc.dim(time({ ms: event.atMs }))} ${event.message}\n`,
              );
              return;
            case "warn":
              io.writeStdout(
                `${pc.dim(time({ ms: event.atMs }))} ${pc.yellow(event.message)}\n`,
              );
              return;
            case "error":
              io.writeStdout(
                `${pc.dim(time({ ms: event.atMs }))} ${pc.red(event.message)}\n`,
              );
              return;
            case "source-open":
              io.writeStdout(
                `${pc.dim(time({ ms: event.atMs }))} ${pc.green("opened")} ${event.source}\n`,
              );
              return;
            case "source-close":
              io.writeStdout(
                `${pc.dim(time({ ms: event.atMs }))} ${pc.yellow("closed")} ${event.source}: ${event.reason}\n`,
              );
              return;
            case "window-opened":
              io.writeStdout(
                `${pc.dim(time({ ms: event.atMs }))} opened ${new Date(event.windowStartMs).toISOString().slice(11, 16)} UTC (${event.assetCount} assets)\n`,
              );
              return;
            case "window-finalized":
              io.writeStdout(
                `${formatReliabilityWindow({
                  windowStartMs: event.windowStartMs,
                  windows: event.windows,
                })}\n`,
              );
          }
        },
      });

      io.writeStdout(`\n${pc.green("wrote")} ${pc.dim(jsonPath)}\n`);
      if (!options.noChart) {
        await writeReliabilityHtml({ payload, htmlPath });
        io.writeStdout(`${pc.green("wrote")} ${pc.dim(htmlPath)}\n`);
        if (!options.noOpen) {
          openHtmlOnDarwin({ path: htmlPath });
        }
      }
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
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

function time({ ms }: { readonly ms: number }): string {
  return new Date(ms).toISOString().slice(11, 19);
}

async function resolveResumeCapture({
  assets,
  resumePath,
}: {
  readonly assets: readonly Asset[];
  readonly resumePath: string | undefined;
}): Promise<{
  readonly path: string;
  readonly payload: ReliabilityCapturePayload;
} | null> {
  if (resumePath !== undefined) {
    const path = resolvePath(resumePath);
    const payload = await loadReliabilityCapture({ path });
    if (!sameAssets({ left: payload.assets, right: assets })) {
      throw new Error(
        `resume capture assets (${payload.assets.join(",")}) do not match requested assets (${assets.join(",")}).`,
      );
    }
    return { path, payload };
  }

  const entries = await readdir(tmpDir, { withFileTypes: true });
  const candidates = entries
    .filter(
      (entry) => entry.isFile() && /^reliability_.*\.json$/.test(entry.name),
    )
    .map((entry) => resolvePath(tmpDir, entry.name))
    .sort()
    .reverse();

  for (const path of candidates) {
    try {
      const payload = await loadReliabilityCapture({ path });
      if (sameAssets({ left: payload.assets, right: assets })) {
        return { path, payload };
      }
    } catch {
      continue;
    }
  }
  return null;
}

function sameAssets({
  left,
  right,
}: {
  readonly left: readonly Asset[];
  readonly right: readonly Asset[];
}): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const expected = new Set(left);
  return right.every((asset) => expected.has(asset));
}
