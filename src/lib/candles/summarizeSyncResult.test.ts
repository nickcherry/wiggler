import { summarizeSyncResult } from "@alea/lib/candles/summarizeSyncResult";
import type { SyncCandlesResult } from "@alea/lib/candles/syncCandles";
import { describe, expect, it } from "bun:test";

function resultWithElapsed(samples: readonly number[]): SyncCandlesResult {
  return {
    source: "coinbase",
    asset: "btc",
    product: "spot",
    timeframe: "1m",
    start: new Date("2026-05-04T00:00:00.000Z"),
    end: new Date("2026-05-04T01:00:00.000Z"),
    pages: samples.map((elapsedMs, index) => ({
      start: new Date(1_777_867_200_000 + index * 60_000),
      end: new Date(1_777_867_260_000 + index * 60_000),
      fetched: 1,
      elapsedMs,
    })),
    fetched: samples.length,
    persisted: samples.length,
    fetchTotalMs: samples.reduce((sum, value) => sum + value, 0),
    upsertTotalMs: 0,
  };
}

describe("summarizeSyncResult", () => {
  it("returns zero stats for syncs without pages", () => {
    expect(summarizeSyncResult({ result: resultWithElapsed([]) })).toEqual({
      count: 0,
      meanMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      maxMs: 0,
    });
  });

  it("computes mean, upper-median p50, p95, and max from page latencies", () => {
    expect(
      summarizeSyncResult({ result: resultWithElapsed([100, 10, 30, 20]) }),
    ).toEqual({
      count: 4,
      meanMs: 40,
      p50Ms: 30,
      p95Ms: 100,
      maxMs: 100,
    });
  });
});
