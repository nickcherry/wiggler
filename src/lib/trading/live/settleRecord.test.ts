import type { ClosedFiveMinuteBar } from "@alea/lib/livePrices/types";
import { settleRecord } from "@alea/lib/trading/live/settleRecord";
import type { AssetWindowRecord } from "@alea/lib/trading/live/types";
import type { AssetSlot } from "@alea/lib/trading/state/types";
import type { TradableMarket } from "@alea/lib/trading/vendor/types";
import type { Asset } from "@alea/types/assets";
import { describe, expect, it } from "bun:test";

const market: TradableMarket = {
  asset: "btc",
  windowStartUnixSeconds: 1_777_867_200,
  windowStartMs: 1_777_867_200_000,
  windowEndMs: 1_777_867_500_000,
  vendorRef: "market-1",
  upRef: "UP",
  downRef: "DOWN",
  acceptingOrders: false,
};

function activeSlot({
  side = "up",
  sharesFilled = 100,
  costUsd = 40,
}: {
  readonly side?: "up" | "down";
  readonly sharesFilled?: number;
  readonly costUsd?: number;
} = {}): Extract<AssetSlot, { kind: "active" }> {
  return {
    kind: "active",
    market,
    side,
    outcomeRef: side === "up" ? "UP" : "DOWN",
    orderId: null,
    limitPrice: 0.4,
    sharesIfFilled: 100,
    sharesFilled,
    costUsd,
    feeRateBpsAvg: 0,
  };
}

function record({
  slot,
  line = 100,
}: {
  readonly slot: AssetSlot;
  readonly line?: number | null;
}): AssetWindowRecord {
  return {
    asset: "btc",
    market,
    hydrationStatus: "ready",
    line,
    lineCapturedAtMs: line === null ? null : 1_777_867_200_000,
    lastDecisionRemaining: null,
    slot,
  };
}

function closedBar(close: number): ClosedFiveMinuteBar {
  return {
    asset: "btc",
    openTimeMs: market.windowStartMs,
    closeTimeMs: market.windowEndMs,
    open: 100,
    high: Math.max(100, close),
    low: Math.min(100, close),
    close,
  };
}

describe("settleRecord", () => {
  it("reports none for empty slots", () => {
    expect(
      settleRecord({
        record: record({ slot: { kind: "empty" } }),
        lastClosedBars: new Map<Asset, ClosedFiveMinuteBar>(),
      }),
    ).toEqual({ asset: "btc", kind: "none" });
  });

  it("recovers the line from the exact bar open when a filled slot has no line price", () => {
    const activeRecord = record({ slot: activeSlot(), line: null });

    expect(
      settleRecord({
        record: activeRecord,
        lastClosedBars: new Map<Asset, ClosedFiveMinuteBar>([
          ["btc", closedBar(101)],
        ]),
      }),
    ).toMatchObject({
      asset: "btc",
      kind: "traded",
      side: "up",
      netPnlUsd: 60,
      won: true,
    });
    expect(activeRecord.line).toBe(100);
    expect(activeRecord.lineCapturedAtMs).toBe(market.windowStartMs);
    expect(activeRecord.slot.kind).toBe("settled");
  });

  it("settles active filled slots against the last closed bar and mutates terminal state", () => {
    const activeRecord = record({ slot: activeSlot() });

    const outcome = settleRecord({
      record: activeRecord,
      lastClosedBars: new Map<Asset, ClosedFiveMinuteBar>([
        ["btc", closedBar(101)],
      ]),
    });

    expect(outcome).toMatchObject({
      asset: "btc",
      kind: "traded",
      side: "up",
      fillPrice: 0.4,
      sharesFilled: 100,
      costUsd: 40,
      feesUsd: 0,
      netPnlUsd: 60,
      won: true,
    });
    expect(activeRecord.slot).toMatchObject({
      kind: "settled",
      netPnlUsd: 60,
      won: true,
    });
  });

  it("marks filled slots pending when the exact closed bar is unavailable", () => {
    const activeRecord = record({ slot: activeSlot({ side: "up" }) });

    const outcome = settleRecord({
      record: activeRecord,
      lastClosedBars: new Map<Asset, ClosedFiveMinuteBar>(),
    });

    expect(outcome).toEqual({
      asset: "btc",
      kind: "pending",
      side: "up",
      limitPrice: 0.4,
      reason: "missing-close",
    });
    expect(activeRecord.slot.kind).toBe("active");
  });

  it("does not settle against a closed bar from another window", () => {
    const activeRecord = record({ slot: activeSlot({ side: "up" }) });
    const wrongWindowBar = {
      ...closedBar(101),
      openTimeMs: market.windowStartMs - 5 * 60_000,
    };

    const outcome = settleRecord({
      record: activeRecord,
      lastClosedBars: new Map<Asset, ClosedFiveMinuteBar>([
        ["btc", wrongWindowBar],
      ]),
    });

    expect(outcome).toMatchObject({
      kind: "pending",
      reason: "missing-close",
    });
  });

  it("turns zero-fill active slots into noFill outcomes", () => {
    const activeRecord = record({
      slot: activeSlot({ sharesFilled: 0, costUsd: 0 }),
    });

    expect(
      settleRecord({
        record: activeRecord,
        lastClosedBars: new Map<Asset, ClosedFiveMinuteBar>([
          ["btc", closedBar(99)],
        ]),
      }),
    ).toEqual({
      asset: "btc",
      kind: "unfilled",
      side: "up",
      limitPrice: 0.4,
    });
    expect(activeRecord.slot.kind).toBe("noFill");
  });
});
