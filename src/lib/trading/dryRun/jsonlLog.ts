import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";

const repoRoot = resolvePath(import.meta.dir, "../../../..");

export const DEFAULT_DRY_TRADING_LOG_DIR = resolvePath(
  repoRoot,
  "tmp/dry-trading",
);

export type DryTradingJsonlWriter = {
  readonly path: string;
  readonly append: (record: unknown) => Promise<void>;
};

export async function createDryTradingJsonlWriter({
  dir = DEFAULT_DRY_TRADING_LOG_DIR,
  nowMs = Date.now(),
}: {
  readonly dir?: string;
  readonly nowMs?: number;
} = {}): Promise<DryTradingJsonlWriter> {
  const timestamp = new Date(nowMs).toISOString().replaceAll(":", "-");
  const path = resolvePath(dir, `dry-trading_${timestamp}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  return {
    path,
    append: async (record) => {
      await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
    },
  };
}
