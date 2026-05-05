import { readdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve as resolvePath } from "node:path";

import { buildDryRunReportPayload } from "@alea/lib/trading/dryRun/report/buildDryRunReportPayload";
import type { DryRunReportPayload } from "@alea/lib/trading/dryRun/report/types";

export async function loadDryRunReportPayload({
  sessionPath,
  dryTradingDir,
  generatedAtMs = Date.now(),
}: {
  readonly sessionPath?: string;
  readonly dryTradingDir: string;
  readonly generatedAtMs?: number;
}): Promise<DryRunReportPayload> {
  const sourcePath =
    sessionPath === undefined
      ? await findLatestDryRunSession({ dryTradingDir })
      : normalizePath({ path: sessionPath });
  const text = await readFile(sourcePath, "utf8");
  const records: unknown[] = [];
  const parseErrors: string[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      records.push(JSON.parse(trimmed));
    } catch (error) {
      parseErrors.push(`line ${index + 1}: ${(error as Error).message}`);
    }
  }
  const payload = buildDryRunReportPayload({
    records,
    sourcePath,
    generatedAtMs,
  });
  return {
    ...payload,
    parseErrors: [...payload.parseErrors, ...parseErrors],
  };
}

export async function findLatestDryRunSession({
  dryTradingDir,
}: {
  readonly dryTradingDir: string;
}): Promise<string> {
  const entries = await readdir(dryTradingDir);
  const candidates = await Promise.all(
    entries
      .filter((entry) => /^dry-trading_.*\.jsonl$/.test(entry))
      .map(async (entry) => {
        const path = resolvePath(dryTradingDir, entry);
        const stats = await stat(path);
        return { path, mtimeMs: stats.mtimeMs, label: basename(path) };
      }),
  );
  candidates.sort(
    (a, b) => b.mtimeMs - a.mtimeMs || b.label.localeCompare(a.label),
  );
  const latest = candidates[0];
  if (latest === undefined) {
    throw new Error(`No dry trading JSONL sessions found in ${dryTradingDir}.`);
  }
  return latest.path;
}

function normalizePath({ path }: { readonly path: string }): string {
  return isAbsolute(path) ? path : resolvePath(process.cwd(), path);
}
