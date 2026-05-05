import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";

import type { DatabaseClient } from "@alea/lib/db/types";
import { ingestSessionJsonl } from "@alea/lib/marketCapture/ingestSessionJsonl";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(resolvePath(tmpdir(), "alea-ingest-"));
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

/**
 * Minimal Kysely lookalike for the only call shape the ingester
 * uses: `db.insertInto("market_event").values(chunk).execute()`.
 * Captures every chunk it sees.
 */
function fakeDatabase(): {
  readonly db: DatabaseClient;
  readonly chunks: () => readonly (readonly Record<string, unknown>[])[];
} {
  const chunks: (readonly Record<string, unknown>[])[] = [];
  const db: DatabaseClient = {
    insertInto: (_table: string) => ({
      values: (rows: Record<string, unknown>[]) => ({
        execute: async () => {
          chunks.push([...rows]);
          return [];
        },
      }),
    }),
  } as unknown as DatabaseClient;
  return {
    db,
    chunks: () => chunks.slice(),
  };
}

describe("ingestSessionJsonl", () => {
  it("parses each line, batches into chunks, and renames the file on success", async () => {
    const path = resolvePath(dir, "session.jsonl");
    const lines = [
      JSON.stringify({
        tsMs: 1,
        receivedMs: 1,
        source: "binance-perp",
        asset: "btc",
        kind: "bbo",
        marketRef: "BTCUSDT",
        payload: { bid: 1 },
      }),
      JSON.stringify({
        tsMs: 2,
        receivedMs: 2,
        source: "polymarket",
        asset: "btc",
        kind: "trade",
        marketRef: "0xabc",
        payload: { price: 0.5 },
      }),
    ];
    await writeFile(path, lines.join("\n") + "\n");

    const { db, chunks } = fakeDatabase();
    const result = await ingestSessionJsonl({ db, path, chunkSize: 100 });

    expect(result.rowsInserted).toBe(2);
    expect(result.parseErrors).toBe(0);

    const inserted = chunks().flat();
    expect(inserted).toHaveLength(2);
    const first = inserted[0]!;
    expect(first.source).toBe("binance-perp");
    expect(first.market_ref).toBe("BTCUSDT");
    expect(typeof first.payload).toBe("string");
    expect(JSON.parse(first.payload as string)).toEqual({ bid: 1 });

    const remaining = await readdir(dir);
    expect(remaining).toEqual(["session.jsonl.ingested"]);
  });

  it("counts parse errors without aborting the load", async () => {
    const path = resolvePath(dir, "with-errors.jsonl");
    const goodLine = JSON.stringify({
      tsMs: 1,
      receivedMs: 1,
      source: "polymarket",
      asset: "eth",
      kind: "trade",
      marketRef: "0xeth",
      payload: { price: 0.6 },
    });
    await writeFile(
      path,
      [
        goodLine,
        "not-json",
        // missing required fields
        JSON.stringify({ tsMs: 1, source: "x" }),
        goodLine,
      ].join("\n") + "\n",
    );

    const { db, chunks } = fakeDatabase();
    const result = await ingestSessionJsonl({ db, path, chunkSize: 100 });

    expect(result.rowsInserted).toBe(2);
    expect(result.parseErrors).toBe(2);
    expect(chunks().flat()).toHaveLength(2);
  });

  it("respects chunkSize when batching inserts", async () => {
    const path = resolvePath(dir, "chunky.jsonl");
    const lines: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      lines.push(
        JSON.stringify({
          tsMs: i,
          receivedMs: i,
          source: "binance-perp",
          asset: "btc",
          kind: "bbo",
          marketRef: "BTCUSDT",
          payload: { i },
        }),
      );
    }
    await writeFile(path, lines.join("\n") + "\n");

    const { db, chunks } = fakeDatabase();
    await ingestSessionJsonl({ db, path, chunkSize: 3 });
    expect(chunks().map((chunk) => chunk.length)).toEqual([3, 3, 1]);
  });

  it("does not rename when markIngested is false", async () => {
    const path = resolvePath(dir, "keep.jsonl");
    await writeFile(
      path,
      JSON.stringify({
        tsMs: 1,
        receivedMs: 1,
        source: "polymarket",
        asset: "btc",
        kind: "trade",
        marketRef: "0xabc",
        payload: { price: 0.5 },
      }) + "\n",
    );
    const { db } = fakeDatabase();
    await ingestSessionJsonl({ db, path, markIngested: false });
    expect(await readdir(dir)).toEqual(["keep.jsonl"]);
  });
});
