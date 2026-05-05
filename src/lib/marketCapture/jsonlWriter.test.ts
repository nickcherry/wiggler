import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";

import { createCaptureJsonlWriter } from "@alea/lib/marketCapture/jsonlWriter";
import type { CaptureRecord } from "@alea/lib/marketCapture/types";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(resolvePath(tmpdir(), "alea-capture-"));
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

const recordAt = (overrides: Partial<CaptureRecord> = {}): CaptureRecord => ({
  tsMs: Date.parse("2026-05-05T12:32:00.000Z"),
  receivedMs: Date.parse("2026-05-05T12:32:00.000Z"),
  source: "binance-perp",
  asset: "btc",
  kind: "bbo",
  marketRef: "BTCUSDT",
  payload: { bid: 100, ask: 100.1 },
  ...overrides,
});

describe("createCaptureJsonlWriter", () => {
  it("creates a date-partitioned JSONL file and appends one line per record", async () => {
    const writer = await createCaptureJsonlWriter({
      dir,
      nowMs: () => Date.parse("2026-05-05T12:32:00.000Z"),
    });

    await writer.write(recordAt({ payload: { bid: 1 } }));
    await writer.write(recordAt({ payload: { bid: 2 } }));
    await writer.close();

    const session = writer.currentSession();
    expect(session).toBeNull();

    const dateDir = resolvePath(dir, "2026-05-05");
    const entries = await readdir(dateDir);
    expect(entries.sort()).toEqual([
      "2026-05-05T12-30.jsonl",
      "2026-05-05T12-30.jsonl.complete",
    ]);

    const text = await readFile(
      resolvePath(dateDir, "2026-05-05T12-30.jsonl"),
      "utf8",
    );
    const lines = text.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    expect(parseRecord(lines[0]!).payload.bid).toBe(1);
    expect(parseRecord(lines[1]!).payload.bid).toBe(2);
  });

  it("rotates files at the 5-minute boundary using wall-clock at write time", async () => {
    const rolledOver: { closedSession: { windowKey: string }; closedPath: string }[] = [];
    let now = Date.parse("2026-05-05T12:32:00.000Z");
    const writer = await createCaptureJsonlWriter({
      dir,
      nowMs: () => now,
      onRollover: async ({ closedSession, closedPath }) => {
        rolledOver.push({ closedSession, closedPath });
      },
    });

    // Wall-clock is firmly inside the 12:30 window for the first two
    // writes — even though one record carries an out-of-window tsMs
    // we expect the writer to ignore it and route by wall-clock.
    await writer.write(recordAt());
    now = Date.parse("2026-05-05T12:34:30.000Z");
    await writer.write(
      recordAt({ tsMs: Date.parse("2026-05-05T12:36:00.000Z") }),
    );
    expect(writer.currentSession()?.windowKey).toBe("2026-05-05T12-30");

    // Now wall-clock crosses into 12:35 — rotation triggers regardless
    // of the record's tsMs.
    now = Date.parse("2026-05-05T12:35:01.000Z");
    await writer.write(
      recordAt({ tsMs: Date.parse("2026-05-05T12:34:55.000Z") }),
    );
    expect(writer.currentSession()?.windowKey).toBe("2026-05-05T12-35");
    expect(rolledOver.map((entry) => entry.closedSession.windowKey)).toEqual([
      "2026-05-05T12-30",
    ]);

    // .complete marker dropped on the closed window.
    const completeMarker = await stat(
      resolvePath(
        dir,
        "2026-05-05",
        "2026-05-05T12-30.jsonl.complete",
      ),
    );
    expect(completeMarker.isFile()).toBe(true);

    await writer.close();

    // Closed window has both records; new window has the third.
    const closed = await readFile(
      resolvePath(dir, "2026-05-05", "2026-05-05T12-30.jsonl"),
      "utf8",
    );
    expect(closed.split("\n").filter((line) => line.length > 0)).toHaveLength(
      2,
    );
    const opened = await readFile(
      resolvePath(dir, "2026-05-05", "2026-05-05T12-35.jsonl"),
      "utf8",
    );
    expect(opened.split("\n").filter((line) => line.length > 0)).toHaveLength(
      1,
    );
  });

  it("does NOT flip-flop windows when out-of-order tsMs arrive (boundary-skew bug)", async () => {
    const rolledOver: { closedSession: { windowKey: string } }[] = [];
    const now = Date.parse("2026-05-05T12:35:00.001Z");
    const writer = await createCaptureJsonlWriter({
      dir,
      nowMs: () => now,
      onRollover: async ({ closedSession }) => {
        rolledOver.push({ closedSession });
      },
    });

    // Simulate the live boundary scenario: wall-clock just rolled to
    // 12:35, but events from BEFORE the boundary keep arriving for
    // a couple seconds (cross-venue clock skew). Each event's tsMs
    // is firmly in the 12:30 window — but we want them all in the
    // 12:35 window because that's when we OBSERVED them.
    for (let i = 0; i < 5; i += 1) {
      await writer.write(
        recordAt({
          tsMs: Date.parse("2026-05-05T12:34:59.500Z") + i,
        }),
      );
    }

    // Critical: NO rotation should have happened. Wall-clock has not
    // moved out of 12:35.
    expect(rolledOver).toHaveLength(0);
    expect(writer.currentSession()?.windowKey).toBe("2026-05-05T12-35");
    await writer.close();
  });

  it("preserves write order under interleaved fire-and-forget calls", async () => {
    const writer = await createCaptureJsonlWriter({
      dir,
      nowMs: () => Date.parse("2026-05-05T12:32:00.000Z"),
    });
    // Fire-and-forget: we don't await each write individually. The
    // serialiser is supposed to keep them ordered.
    const writes = Array.from({ length: 100 }, (_, i) =>
      writer.write(recordAt({ payload: { i } })),
    );
    await Promise.all(writes);
    await writer.close();

    const text = await readFile(
      resolvePath(dir, "2026-05-05", "2026-05-05T12-30.jsonl"),
      "utf8",
    );
    const lines = text.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(100);
    for (let i = 0; i < 100; i += 1) {
      expect(parseRecord(lines[i]!).payload.i).toBe(i);
    }
  });

  it("rejects writes after close()", async () => {
    const writer = await createCaptureJsonlWriter({
      dir,
      nowMs: () => Date.parse("2026-05-05T12:32:00.000Z"),
    });
    await writer.close();
    let caught: unknown = null;
    try {
      await writer.write(recordAt());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/capture jsonl writer is closed/);
  });
});

function parseRecord(line: string): {
  readonly payload: Record<string, number>;
} {
  return JSON.parse(line) as { readonly payload: Record<string, number> };
}
