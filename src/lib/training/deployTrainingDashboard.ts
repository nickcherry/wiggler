import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

/**
 * Deploys a freshly-rendered dashboard to the `alea` Cloudflare Worker
 * (https://alea.nickcherryjiggz.workers.dev). Copies the rendered HTML
 * to `tmp/web/index.html`, writes a small deploy-source note, and shells
 * out to `wrangler deploy`.
 *
 * Wrangler config lives at `wrangler.toml` in the project root. It maps
 * `tmp/web/` to the worker's static-assets directory; we don't ship any
 * Worker script — Wrangler serves the directory directly.
 *
 * Returns the deploy URL on success. Throws on Wrangler failure (exit
 * code, missing binary, network problem) — the caller decides whether
 * to escalate or swallow.
 */
export async function deployTrainingDashboard({
  htmlPath,
  webDir,
  cwd,
  onLog,
}: {
  /** Absolute path to the rendered dashboard HTML to publish. */
  readonly htmlPath: string;
  /**
   * Absolute path to the directory Wrangler reads (matches the
   * `[assets].directory` value in `wrangler.toml`). The HTML is copied
   * in as `index.html`.
   */
  readonly webDir: string;
  /**
   * Working directory for the `wrangler deploy` invocation. Should be
   * the repository root (where `wrangler.toml` lives).
   */
  readonly cwd: string;
  /**
   * Optional logger called with each line of Wrangler stdout/stderr.
   * Defaults to `console.log` for ad-hoc use; the CLI command passes
   * its own to keep formatting consistent.
   */
  readonly onLog?: (line: string) => void;
}): Promise<{ readonly url: string }> {
  await mkdir(webDir, { recursive: true });
  await copyFile(htmlPath, resolvePath(webDir, "index.html"));

  // Echo a tiny meta-file alongside the HTML so anyone poking around the
  // deployed assets can tell which local artifact this came from. Not
  // required by Wrangler.
  await writeFile(
    resolvePath(webDir, "deploy-source.txt"),
    `source=${htmlPath}\ndeployedAtMs=${Date.now()}\n`,
  );

  await runWrangler({ cwd, onLog: onLog ?? ((line) => console.log(line)) });
  return { url: "https://alea.nickcherryjiggz.workers.dev" };
}

function runWrangler({
  cwd,
  onLog,
}: {
  readonly cwd: string;
  readonly onLog: (line: string) => void;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    // Inherit the parent process's environment by default — Wrangler
    // needs the OAuth token + path to its own state, both of which live
    // in env vars and home-dir files of the user invoking the CLI.
    const proc = spawn("bunx", ["wrangler", "deploy"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const buffer: string[] = [];
    const ingest = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      buffer.push(text);
      for (const line of text.split(/\r?\n/)) {
        if (line.length > 0) {
          onLog(line);
        }
      }
    };
    proc.stdout?.on("data", ingest);
    proc.stderr?.on("data", ingest);
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `wrangler deploy exited with code ${code}\n` + buffer.join(""),
        ),
      );
    });
  });
}

/**
 * Tiny convenience wrapper: deploys whatever `index.html` already lives
 * in the web directory. Used by the manual-deploy path when the user
 * wants to push the most recently built dashboard without re-running the
 * heavy training pipeline.
 */
export async function ensureDashboardWebDir({
  webDir,
}: {
  readonly webDir: string;
}): Promise<void> {
  await mkdir(webDir, { recursive: true });
  // No-op when index.html already exists; otherwise drop a tiny stub so
  // wrangler doesn't refuse an empty directory.
  const indexPath = resolvePath(webDir, "index.html");
  try {
    await readFile(indexPath, "utf8");
  } catch {
    await writeFile(
      indexPath,
      "<!doctype html><title>alea</title><p>No dashboard built yet.</p>",
    );
  }
}
