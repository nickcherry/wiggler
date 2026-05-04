import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";

import { createDryTradingJsonlWriter } from "@alea/lib/trading/dryRun/jsonlLog";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(resolvePath(tmpdir(), "alea-dry-log-"));
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("createDryTradingJsonlWriter", () => {
  it("creates a timestamped JSONL file and appends complete records", async () => {
    const writer = await createDryTradingJsonlWriter({
      dir,
      nowMs: Date.parse("2026-05-04T12:34:56.789Z"),
    });

    await writer.append({ type: "session_start", ok: true });
    await writer.append({ type: "window_checkpoint", n: 1 });

    expect(writer.path.endsWith("dry-trading_2026-05-04T12-34-56.789Z.jsonl")).toBe(
      true,
    );
    expect((await readFile(writer.path, "utf8")).split("\n")).toEqual([
      '{"type":"session_start","ok":true}',
      '{"type":"window_checkpoint","n":1}',
      "",
    ]);
  });
});
