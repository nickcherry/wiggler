import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";

import { scanPendingSessions } from "@alea/lib/marketCapture/scanPendingSessions";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(resolvePath(tmpdir(), "alea-scan-"));
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("scanPendingSessions", () => {
  it("returns nothing when the capture directory is missing", async () => {
    const result = await scanPendingSessions({
      dir: resolvePath(dir, "does-not-exist"),
      activeFileName: "anything.jsonl",
    });
    expect(result).toEqual([]);
  });

  it("finds .jsonl files across date subdirs and tags complete-marker presence", async () => {
    const dayA = resolvePath(dir, "2026-05-05");
    const dayB = resolvePath(dir, "2026-05-06");
    await mkdir(dayA, { recursive: true });
    await mkdir(dayB, { recursive: true });

    // dayA: cleanly rotated (has .complete)
    await writeFile(resolvePath(dayA, "2026-05-05T12-30.jsonl"), "");
    await writeFile(
      resolvePath(dayA, "2026-05-05T12-30.jsonl.complete"),
      "",
    );

    // dayA: orphaned (no .complete, presumably from a kill -9)
    await writeFile(resolvePath(dayA, "2026-05-05T13-00.jsonl"), "");

    // dayA: already ingested — should be ignored
    await writeFile(
      resolvePath(dayA, "2026-05-05T11-00.jsonl.ingested"),
      "",
    );

    // dayB: also cleanly rotated
    await writeFile(resolvePath(dayB, "2026-05-06T00-00.jsonl"), "");
    await writeFile(
      resolvePath(dayB, "2026-05-06T00-00.jsonl.complete"),
      "",
    );

    const result = await scanPendingSessions({
      dir,
      activeFileName: "irrelevant.jsonl",
    });
    const byName = Object.fromEntries(
      result.map((entry) => [entry.fileName, entry.hasCompleteMarker]),
    );
    expect(byName).toEqual({
      "2026-05-05T12-30.jsonl": true,
      "2026-05-05T13-00.jsonl": false,
      "2026-05-06T00-00.jsonl": true,
    });
  });

  it("skips the active session by filename", async () => {
    const day = resolvePath(dir, "2026-05-05");
    await mkdir(day, { recursive: true });
    await writeFile(resolvePath(day, "2026-05-05T12-30.jsonl"), "");
    await writeFile(resolvePath(day, "2026-05-05T12-35.jsonl"), "");

    const result = await scanPendingSessions({
      dir,
      activeFileName: "2026-05-05T12-35.jsonl",
    });
    expect(result.map((entry) => entry.fileName)).toEqual([
      "2026-05-05T12-30.jsonl",
    ]);
  });
});
