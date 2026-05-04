import { formatDryOrderPrepared } from "@alea/lib/trading/dryRun/formatDryOrderPrepared";
import { describe, expect, it } from "bun:test";

describe("formatDryOrderPrepared", () => {
  it("makes clear the dry-run order was virtual while preserving live-order context", () => {
    const text = formatDryOrderPrepared({
      asset: "btc",
      side: "up",
      stakeUsd: 20,
      underlyingPrice: 80_251.35,
      linePrice: 80_253.1,
      limitPrice: 0.61,
      sharesIfFilled: 32.79,
      modelProbability: 0.72,
      edge: 0.11,
      queueAheadShares: 12.34,
      windowEndMs: Date.parse("2026-05-04T12:35:00.000Z"),
      nowMs: Date.parse("2026-05-04T12:32:40.000Z"),
    });

    expect(text).toBe(
      [
        "DRY RUN: prepared virtual order for $20 of BTC ↑ at $0.61",
        "",
        "Underlying is $80,251.35. Price line is $80,253.10 (+0.002%).",
        "Model p=0.720, edge=+0.110; shares=32.79; queue ahead=12.34.",
        "Market expires in 2 minutes 20 seconds.",
      ].join("\n"),
    );
  });

  it("renders unknown queue depth conservatively", () => {
    const text = formatDryOrderPrepared({
      asset: "doge",
      side: "down",
      stakeUsd: 20.5,
      underlyingPrice: 0.18241,
      linePrice: 0.182,
      limitPrice: 0.615,
      sharesIfFilled: 33.33,
      modelProbability: 0.7,
      edge: null,
      queueAheadShares: null,
      windowEndMs: Date.parse("2026-05-04T12:35:00.000Z"),
      nowMs: Date.parse("2026-05-04T12:34:45.000Z"),
    });

    expect(text).toContain("DRY RUN: prepared virtual order for $20.50");
    expect(text).toContain("at $0.615");
    expect(text).toContain("edge=--");
    expect(text).toContain("queue ahead=unknown");
    expect(text).toContain("Market expires in 15 seconds.");
  });
});
