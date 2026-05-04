import { applyFill } from "@alea/lib/trading/live/applyFill";
import type {
  AssetWindowRecord,
  LiveEvent,
} from "@alea/lib/trading/live/types";
import type { AssetSlot } from "@alea/lib/trading/state/types";
import type { TradableMarket } from "@alea/lib/trading/vendor/types";
import { describe, expect, it } from "bun:test";

const market: TradableMarket = {
  asset: "btc",
  windowStartUnixSeconds: 1_777_867_200,
  windowStartMs: 1_777_867_200_000,
  windowEndMs: 1_777_867_500_000,
  vendorRef: "market-1",
  upRef: "UP",
  downRef: "DOWN",
  acceptingOrders: true,
};

function activeSlot({
  outcomeRef = "UP",
  orderId = "order-1",
  sharesIfFilled = 10,
  sharesFilled = 2,
  costUsd = 1,
  feeRateBpsAvg = 10,
}: {
  readonly outcomeRef?: string;
  readonly orderId?: string | null;
  readonly sharesIfFilled?: number;
  readonly sharesFilled?: number;
  readonly costUsd?: number;
  readonly feeRateBpsAvg?: number;
} = {}): Extract<AssetSlot, { kind: "active" }> {
  return {
    kind: "active",
    market,
    side: outcomeRef === "UP" ? "up" : "down",
    outcomeRef,
    orderId,
    limitPrice: 0.5,
    sharesIfFilled,
    sharesFilled,
    costUsd,
    feeRateBpsAvg,
  };
}

function record(slot: AssetSlot): AssetWindowRecord {
  return {
    asset: "btc",
    market,
    hydrationStatus: "ready",
    line: 100,
    lineCapturedAtMs: 1_777_867_200_000,
    lastDecisionRemaining: null,
    slot,
  };
}

describe("applyFill", () => {
  it("ignores non-active slots and fills for other outcomes", () => {
    const events: LiveEvent[] = [];
    const emptyRecord = record({ kind: "empty" });
    applyFill({
      asset: "btc",
      record: emptyRecord,
      fill: { outcomeRef: "UP", price: 0.4, size: 1, feeRateBps: 20 },
      emit: (event) => events.push(event),
    });
    expect(emptyRecord.slot).toEqual({ kind: "empty" });

    const activeRecord = record(activeSlot({ outcomeRef: "UP" }));
    applyFill({
      asset: "btc",
      record: activeRecord,
      fill: { outcomeRef: "DOWN", price: 0.4, size: 1, feeRateBps: 20 },
      emit: (event) => events.push(event),
    });

    expect(activeRecord.slot).toEqual(activeSlot({ outcomeRef: "UP" }));
    expect(events).toEqual([]);
  });

  it("accumulates cost, shares, and weighted fee rate for partial fills", () => {
    const events: LiveEvent[] = [];
    const activeRecord = record(activeSlot());

    applyFill({
      asset: "btc",
      record: activeRecord,
      fill: { outcomeRef: "UP", price: 0.4, size: 3, feeRateBps: 20 },
      emit: (event) => events.push(event),
    });

    expect(activeRecord.slot).toMatchObject({
      kind: "active",
      orderId: "order-1",
      sharesFilled: 5,
      costUsd: 2.2,
      feeRateBpsAvg: 16,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "fill",
      asset: "btc",
      slot: activeRecord.slot,
    });
  });

  it("clears orderId once cumulative fills reach accepted shares", () => {
    const activeRecord = record(
      activeSlot({
        sharesIfFilled: 5,
        sharesFilled: 2,
        orderId: "order-1",
      }),
    );

    applyFill({
      asset: "btc",
      record: activeRecord,
      fill: { outcomeRef: "UP", price: 0.4, size: 3, feeRateBps: 20 },
      emit: () => {},
    });

    expect(activeRecord.slot).toMatchObject({
      kind: "active",
      orderId: null,
      sharesFilled: 5,
    });
  });
});
