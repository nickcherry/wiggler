import { hydrateAssetMarket } from "@alea/lib/trading/live/marketHydration";
import type {
  AssetWindowRecord,
  ConditionIndex,
  LiveEvent,
  WindowRecord,
} from "@alea/lib/trading/live/types";
import type {
  MarketHydration,
  TradableMarket,
  UserStreamCallbacks,
  Vendor,
} from "@alea/lib/trading/vendor/types";
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
  displayLabel: "btc-market",
};

function record(): AssetWindowRecord {
  return {
    asset: "btc",
    market: null,
    hydrationStatus: "pending",
    line: null,
    lineCapturedAtMs: null,
    lastDecisionRemaining: null,
    slot: { kind: "empty" },
  };
}

function windowRecord(): WindowRecord {
  return {
    windowStartMs: market.windowStartMs,
    windowEndMs: market.windowEndMs,
    perAsset: new Map(),
    summarySent: false,
    cancelTimer: null,
    wrapUpTimer: null,
    rejectedCount: 0,
    placedAfterRetryCount: 0,
    settlementRetryCount: 0,
  };
}

function vendorWith({
  discovered,
  hydration,
  discoverError,
  hydrationError,
}: {
  readonly discovered: TradableMarket | null;
  readonly hydration?: MarketHydration;
  readonly discoverError?: Error;
  readonly hydrationError?: Error;
}): Vendor {
  return {
    id: "fake",
    walletAddress: "0xwallet",
    async discoverMarket() {
      if (discoverError !== undefined) {
        throw discoverError;
      }
      return discovered;
    },
    async fetchBook() {
      throw new Error("not used");
    },
    async placeMakerLimitBuy() {
      throw new Error("not used");
    },
    async cancelOrder() {
      throw new Error("not used");
    },
    streamUserFills(
      _input: {
        readonly markets: readonly TradableMarket[];
      } & UserStreamCallbacks,
    ) {
      return { stop: async () => {} };
    },
    async hydrateMarketState() {
      if (hydrationError !== undefined) {
        throw hydrationError;
      }
      return (
        hydration ?? {
          openOrder: null,
          side: null,
          outcomeRef: null,
          sharesFilled: 0,
          costUsd: 0,
          feeRateBpsAvg: 0,
        }
      );
    },
    async scanLifetimePnl() {
      throw new Error("not used");
    },
  };
}

describe("hydrateAssetMarket", () => {
  it("discovers a market, indexes it, subscribes, and emits the discovered state", async () => {
    const assetRecord = record();
    const index: ConditionIndex = new Map();
    const events: LiveEvent[] = [];
    let subscribeCount = 0;

    await hydrateAssetMarket({
      asset: "btc",
      record: assetRecord,
      window: windowRecord(),
      vendor: vendorWith({ discovered: market }),
      conditionIdIndex: index,
      onSubscribe: () => {
        subscribeCount += 1;
      },
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    });

    expect(assetRecord.market).toBe(market);
    expect(assetRecord.hydrationStatus).toBe("ready");
    expect(index.get("market-1")).toEqual({
      windowStartMs: market.windowStartMs,
      asset: "btc",
    });
    expect(subscribeCount).toBe(1);
    expect(assetRecord.slot).toEqual({ kind: "empty" });
    expect(events.at(-1)).toMatchObject({
      kind: "info",
      message: "BTC   discovered btc-market, accepting=true",
    });
  });

  it("hydrates leftover fills into an active slot using the fill average as limit fallback", async () => {
    const assetRecord = record();
    const events: LiveEvent[] = [];

    await hydrateAssetMarket({
      asset: "btc",
      record: assetRecord,
      window: windowRecord(),
      vendor: vendorWith({
        discovered: market,
        hydration: {
          openOrder: null,
          side: "up",
          outcomeRef: null,
          sharesFilled: 4,
          costUsd: 2,
          feeRateBpsAvg: 12,
        },
      }),
      conditionIdIndex: new Map(),
      onSubscribe: () => {},
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    });

    expect(assetRecord.slot).toMatchObject({
      kind: "active",
      market,
      side: "up",
      outcomeRef: "UP",
      orderId: null,
      limitPrice: 0.5,
      sharesIfFilled: 4,
      sharesFilled: 4,
      costUsd: 2,
      feeRateBpsAvg: 12,
    });
    expect(assetRecord.hydrationStatus).toBe("ready");
    expect(events.map((event) => event.kind)).toEqual(["info", "info"]);
    expect(events[0]).toMatchObject({
      message: "BTC   hydrated leftover state: side=up order=none filled=4",
    });
  });

  it("logs and leaves state empty when the market is missing or discovery fails", async () => {
    const missingRecord = record();
    const missingEvents: LiveEvent[] = [];

    await hydrateAssetMarket({
      asset: "btc",
      record: missingRecord,
      window: windowRecord(),
      vendor: vendorWith({ discovered: null }),
      conditionIdIndex: new Map(),
      onSubscribe: () => {},
      signal: new AbortController().signal,
      emit: (event) => missingEvents.push(event),
    });

    expect(missingRecord.market).toBeNull();
    expect(missingRecord.hydrationStatus).toBe("failed");
    expect(missingRecord.slot).toEqual({ kind: "empty" });
    expect(missingEvents[0]).toMatchObject({
      kind: "warn",
      message: "BTC   no fake market for window 04:00",
    });

    const errorEvents: LiveEvent[] = [];
    await hydrateAssetMarket({
      asset: "btc",
      record: record(),
      window: windowRecord(),
      vendor: vendorWith({
        discovered: null,
        discoverError: new Error("offline"),
      }),
      conditionIdIndex: new Map(),
      onSubscribe: () => {},
      signal: new AbortController().signal,
      emit: (event) => errorEvents.push(event),
    });

    expect(errorEvents[0]).toMatchObject({
      kind: "error",
      message: "BTC   market discovery failed: offline",
    });
  });

  it("keeps the discovered market but disables trading when vendor state hydration fails", async () => {
    const assetRecord = record();
    const events: LiveEvent[] = [];

    await hydrateAssetMarket({
      asset: "btc",
      record: assetRecord,
      window: windowRecord(),
      vendor: vendorWith({
        discovered: market,
        hydrationError: new Error("auth expired"),
      }),
      conditionIdIndex: new Map(),
      onSubscribe: () => {},
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    });

    expect(assetRecord.market).toBe(market);
    expect(assetRecord.hydrationStatus).toBe("failed");
    expect(assetRecord.slot).toEqual({ kind: "empty" });
    expect(events[0]).toMatchObject({
      kind: "warn",
      message:
        "BTC   state hydration failed (trading disabled for this market): auth expired",
    });
  });
});
