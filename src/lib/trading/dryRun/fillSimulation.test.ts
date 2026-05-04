import {
  applyTradeToSimulatedOrder,
  canonicalFillLatencyMs,
  createSimulatedDryOrder,
  touchFillLatencyMs,
} from "@alea/lib/trading/dryRun/fillSimulation";
import type { MarketDataTradeEvent } from "@alea/lib/trading/vendor/types";
import { describe, expect, it } from "bun:test";

const placedAtMs = 1_777_900_200_000;

function order(overrides = {}) {
  return createSimulatedDryOrder({
    id: "dry-order",
    asset: "btc",
    windowStartMs: placedAtMs - 60_000,
    windowEndMs: placedAtMs + 180_000,
    vendorRef: "condition",
    outcomeRef: "UP",
    side: "up",
    limitPrice: 0.5,
    sharesIfFilled: 10,
    placedAtMs,
    expiresAtMs: placedAtMs + 120_000,
    queueAheadShares: 5,
    ...overrides,
  });
}

function trade(
  overrides: Partial<MarketDataTradeEvent> = {},
): MarketDataTradeEvent {
  return {
    kind: "trade",
    vendorRef: "condition",
    outcomeRef: "UP",
    price: 0.5,
    size: 1,
    side: "SELL",
    atMs: placedAtMs + 1_000,
    ...overrides,
  };
}

describe("applyTradeToSimulatedOrder", () => {
  it("fills fully when a later trade prints below our bid", () => {
    const simulated = order();

    expect(
      applyTradeToSimulatedOrder({
        order: simulated,
        trade: trade({ price: 0.49, size: null, atMs: placedAtMs + 2_000 }),
      }),
    ).toBe(true);

    expect(simulated.canonicalFilledShares).toBe(10);
    expect(simulated.canonicalCostUsd).toBe(5);
    expect(canonicalFillLatencyMs({ order: simulated })).toBe(2_000);
    expect(touchFillLatencyMs({ order: simulated })).toBe(2_000);
  });

  it("waits for exact-price volume to clear the queue ahead", () => {
    const simulated = order({ queueAheadShares: 5 });

    applyTradeToSimulatedOrder({
      order: simulated,
      trade: trade({ price: 0.5, size: 3, atMs: placedAtMs + 1_000 }),
    });
    expect(simulated.canonicalFilledShares).toBe(0);
    expect(simulated.touchFilledAtMs).toBe(placedAtMs + 1_000);

    applyTradeToSimulatedOrder({
      order: simulated,
      trade: trade({ price: 0.5, size: 4, atMs: placedAtMs + 2_000 }),
    });
    expect(simulated.canonicalFilledShares).toBe(2);
    expect(simulated.canonicalFirstFillAtMs).toBe(placedAtMs + 2_000);

    applyTradeToSimulatedOrder({
      order: simulated,
      trade: trade({ price: 0.5, size: 20, atMs: placedAtMs + 3_000 }),
    });
    expect(simulated.canonicalFilledShares).toBe(10);
    expect(simulated.canonicalFullFillAtMs).toBe(placedAtMs + 3_000);
  });

  it("does not exact-price fill when queue depth is unknown", () => {
    const simulated = order({ queueAheadShares: null });

    applyTradeToSimulatedOrder({
      order: simulated,
      trade: trade({ price: 0.5, size: 100 }),
    });

    expect(simulated.canonicalFilledShares).toBe(0);
    expect(simulated.touchFilledAtMs).toBe(placedAtMs + 1_000);
  });

  it("ignores trades after expiry and for other tokens", () => {
    const simulated = order();

    applyTradeToSimulatedOrder({
      order: simulated,
      trade: trade({ outcomeRef: "DOWN", price: 0.1 }),
    });
    applyTradeToSimulatedOrder({
      order: simulated,
      trade: trade({ price: 0.1, atMs: placedAtMs + 121_000 }),
    });

    expect(simulated.canonicalFilledShares).toBe(0);
    expect(simulated.touchFilledAtMs).toBeNull();
  });
});
