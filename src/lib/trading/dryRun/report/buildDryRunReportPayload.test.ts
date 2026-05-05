import { buildDryRunReportPayload } from "@alea/lib/trading/dryRun/report/buildDryRunReportPayload";
import { describe, expect, it } from "bun:test";

describe("buildDryRunReportPayload", () => {
  it("summarizes canonical fills, unfilled counterfactuals, and asset rows", () => {
    const payload = buildDryRunReportPayload({
      sourcePath: "/tmp/dry-trading_2026.jsonl",
      generatedAtMs: Date.parse("2026-05-04T12:40:00.000Z"),
      records: [
        {
          type: "session_start",
          atMs: Date.parse("2026-05-04T12:30:00.000Z"),
          config: {
            vendor: "polymarket",
            priceSource: "binance-perp",
            assets: ["btc", "eth"],
            minEdge: 0.05,
            stakeUsd: 20,
            tableRange: "2023-01-01..2026-01-01",
            telegramAlerts: true,
          },
        },
        {
          type: "window_finalized",
          atMs: Date.parse("2026-05-04T12:35:08.000Z"),
          windowStartMs: Date.parse("2026-05-04T12:30:00.000Z"),
          windowEndMs: Date.parse("2026-05-04T12:35:00.000Z"),
          orders: [
            order({
              id: "filled-win",
              asset: "btc",
              side: "up",
              officialOutcome: "up",
              proxyOutcome: { winningSide: "up" },
              canonicalFilledShares: 40,
              sharesIfFilled: 40,
              limitPrice: 0.5,
            }),
            order({
              id: "unfilled-win",
              asset: "eth",
              side: "down",
              officialOutcome: "down",
              proxyOutcome: { winningSide: "up" },
              canonicalFilledShares: 0,
              sharesIfFilled: 50,
              limitPrice: 0.4,
            }),
          ],
        },
      ],
    });

    expect(payload.summary.orderCount).toBe(2);
    expect(payload.summary.canonicalFilledCount).toBe(1);
    expect(payload.summary.canonicalFillRate).toBe(0.5);
    expect(payload.summary.filledWinRate).toBe(1);
    expect(payload.summary.unfilledWouldWinCount).toBe(1);
    expect(payload.summary.officialProxyDisagreementCount).toBe(1);
    expect(payload.summary.canonicalPnlUsd).toBe(20);
    expect(payload.summary.allOrdersFilledPnlUsd).toBe(50);
    expect(payload.summary.fillSelectionDeltaUsd).toBe(-30);
    expect(payload.byAsset.map((row) => row.asset)).toEqual(["btc", "eth"]);
    expect(payload.windows[0]?.canonicalPnlUsd).toBe(20);
  });
});

function order({
  id,
  asset,
  side,
  officialOutcome,
  proxyOutcome,
  canonicalFilledShares,
  sharesIfFilled,
  limitPrice,
}: {
  readonly id: string;
  readonly asset: string;
  readonly side: string;
  readonly officialOutcome: string;
  readonly proxyOutcome: { readonly winningSide: string };
  readonly canonicalFilledShares: number;
  readonly sharesIfFilled: number;
  readonly limitPrice: number;
}): Record<string, unknown> {
  const placedAtMs = Date.parse("2026-05-04T12:31:00.000Z");
  return {
    id,
    asset,
    windowStartMs: Date.parse("2026-05-04T12:30:00.000Z"),
    windowEndMs: Date.parse("2026-05-04T12:35:00.000Z"),
    side,
    limitPrice,
    sharesIfFilled,
    placedAtMs,
    expiresAtMs: Date.parse("2026-05-04T12:34:50.000Z"),
    queueAheadShares: 10,
    observedAtLimitShares: 20,
    canonicalFilledShares,
    canonicalCostUsd: canonicalFilledShares * limitPrice,
    canonicalFirstFillAtMs:
      canonicalFilledShares > 0 ? placedAtMs + 2_000 : null,
    canonicalFullFillAtMs:
      canonicalFilledShares > 0 ? placedAtMs + 2_000 : null,
    touchFilledAtMs: placedAtMs + 1_000,
    entryPrice: 100,
    line: 99,
    upBestBid: 0.5,
    upBestAsk: 0.52,
    downBestBid: 0.48,
    downBestAsk: 0.5,
    spread: 0.02,
    remaining: 4,
    distanceBp: 10,
    samples: 1000,
    modelProbability: 0.7,
    edge: 0.2,
    officialOutcome,
    proxyOutcome,
    officialResolvedAtMs: Date.parse("2026-05-04T12:35:05.000Z"),
    officialPendingReason: null,
  };
}
