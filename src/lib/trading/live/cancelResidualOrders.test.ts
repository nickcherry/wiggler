import { cancelResidualOrders } from "@alea/lib/trading/live/cancelResidualOrders";
import type {
  AssetWindowRecord,
  LiveEvent,
  WindowRecord,
} from "@alea/lib/trading/live/types";
import type { AssetSlot } from "@alea/lib/trading/state/types";
import type {
  TradableMarket,
  UserStreamCallbacks,
  Vendor,
} from "@alea/lib/trading/vendor/types";
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

function activeSlot(orderId: string | null): Extract<AssetSlot, { kind: "active" }> {
  return {
    kind: "active",
    market,
    side: "up",
    outcomeRef: "UP",
    orderId,
    limitPrice: 0.5,
    sharesIfFilled: 10,
    sharesFilled: 2,
    costUsd: 1,
    feeRateBpsAvg: 0,
  };
}

function record(asset: Asset, slot: AssetSlot): AssetWindowRecord {
  return {
    asset,
    market,
    line: 100,
    lineCapturedAtMs: market.windowStartMs,
    lastDecisionRemaining: null,
    slot,
  };
}

function windowWith(records: readonly AssetWindowRecord[]): WindowRecord {
  return {
    windowStartMs: market.windowStartMs,
    windowEndMs: market.windowEndMs,
    perAsset: new Map(records.map((assetRecord) => [assetRecord.asset, assetRecord])),
    summarySent: false,
    cancelTimer: null,
    wrapUpTimer: null,
    rejectedCount: 0,
    placedAfterRetryCount: 0,
  };
}

function vendorReturning({
  accepted,
  errorMessage,
  seen,
}: {
  readonly accepted: boolean;
  readonly errorMessage: string | null;
  readonly seen: string[];
}): Vendor {
  return {
    id: "fake",
    walletAddress: "0xwallet",
    async discoverMarket() {
      return null;
    },
    async fetchBook() {
      throw new Error("not used");
    },
    async placeMakerLimitBuy() {
      throw new Error("not used");
    },
    async cancelOrder({ orderId }) {
      seen.push(orderId);
      return { accepted, errorMessage };
    },
    streamUserFills(_input: { readonly markets: readonly TradableMarket[] } & UserStreamCallbacks) {
      return { stop: async () => {} };
    },
    async hydrateMarketState() {
      throw new Error("not used");
    },
    async scanLifetimePnl() {
      throw new Error("not used");
    },
  };
}

describe("cancelResidualOrders", () => {
  it("cancels only active slots with a live orderId and clears the local order id", async () => {
    const active = record("btc", activeSlot("order-abc123456789"));
    const alreadyFilled = record("eth", activeSlot(null));
    const empty = record("sol", { kind: "empty" });
    const seen: string[] = [];
    const events: LiveEvent[] = [];

    await cancelResidualOrders({
      window: windowWith([active, alreadyFilled, empty]),
      vendor: vendorReturning({ accepted: true, errorMessage: null, seen }),
      emit: (event) => events.push(event),
    });

    expect(seen).toEqual(["order-abc123456789"]);
    expect(active.slot).toMatchObject({ kind: "active", orderId: null });
    expect(alreadyFilled.slot).toMatchObject({ kind: "active", orderId: null });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "info",
      message: "BTC   cancel order-abc1…: ok",
    });
  });

  it("logs a warning when the venue rejects the cancel", async () => {
    const active = record("btc", activeSlot("order-rejected"));
    const events: LiveEvent[] = [];

    await cancelResidualOrders({
      window: windowWith([active]),
      vendor: vendorReturning({
        accepted: false,
        errorMessage: "already matched",
        seen: [],
      }),
      emit: (event) => events.push(event),
    });

    expect(active.slot).toMatchObject({ kind: "active", orderId: null });
    expect(events[0]).toMatchObject({
      kind: "warn",
      message: "BTC   cancel order-reje…: already matched",
    });
  });
});
