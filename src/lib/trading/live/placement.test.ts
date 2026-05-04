import { createFiveMinuteEmaTracker } from "@alea/lib/livePrices/fiveMinuteEmaTracker";
import type { LivePriceTick } from "@alea/lib/livePrices/types";
import { applyFill } from "@alea/lib/trading/live/applyFill";
import { placeWithRetry } from "@alea/lib/trading/live/placement";
import type {
  AssetWindowRecord,
  BookCache,
  LiveEvent,
  WindowRecord,
} from "@alea/lib/trading/live/types";
import type { AssetSlot } from "@alea/lib/trading/state/types";
import type { ProbabilityTable } from "@alea/lib/trading/types";
import type {
  MarketHydration,
  PlacedOrder,
  TradableMarket,
  UserStreamCallbacks,
  Vendor,
} from "@alea/lib/trading/vendor/types";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const NOW = Date.UTC(2026, 0, 1, 0, 2, 0);
const WINDOW_START = NOW - 2 * 60_000;

const market: TradableMarket = {
  asset: "btc",
  windowStartUnixSeconds: Math.floor(WINDOW_START / 1000),
  windowStartMs: WINDOW_START,
  windowEndMs: WINDOW_START + 5 * 60_000,
  vendorRef: "condition",
  upRef: "UP",
  downRef: "DOWN",
  acceptingOrders: true,
};

const table: ProbabilityTable = {
  command: "trading:gen-probability-table",
  schemaVersion: 1,
  generatedAtMs: 0,
  series: { source: "binance", product: "perp", timeframe: "5m" },
  minBucketSamples: 200,
  trainingRangeMs: { firstWindowMs: 0, lastWindowMs: 0 },
  assets: [
    {
      asset: "btc",
      windowCount: 1,
      alignedWindowShare: 1,
      aligned: {
        byRemaining: {
          1: [],
          2: [],
          3: [{ distanceBp: 5, samples: 500, probability: 0.85 }],
          4: [],
        },
      },
      notAligned: { byRemaining: { 1: [], 2: [], 3: [], 4: [] } },
    },
  ],
};

const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;

beforeEach(() => {
  Date.now = () => NOW;
  globalThis.fetch = Object.assign(
    async () =>
      Response.json({ ok: true, result: { message_id: 1, date: 0, chat: {} } }),
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  Date.now = originalDateNow;
  globalThis.fetch = originalFetch;
});

function record(slot: AssetSlot = { kind: "empty" }): AssetWindowRecord {
  return {
    asset: "btc",
    market,
    hydrationStatus: "ready",
    line: 100,
    lineCapturedAtMs: WINDOW_START + 500,
    lastDecisionRemaining: null,
    slot,
  };
}

function windowRecord(): WindowRecord {
  return {
    windowStartMs: WINDOW_START,
    windowEndMs: WINDOW_START + 5 * 60_000,
    perAsset: new Map(),
    summarySent: false,
    cancelTimer: null,
    wrapUpTimer: null,
    rejectedCount: 0,
    placedAfterRetryCount: 0,
    settlementRetryCount: 0,
  };
}

function lastTick(): ReadonlyMap<"btc", LivePriceTick> {
  return new Map([
    [
      "btc",
      {
        asset: "btc",
        bid: 100.04,
        ask: 100.06,
        mid: 100.05,
        exchangeTimeMs: NOW - 100,
        receivedAtMs: NOW - 50,
      },
    ],
  ]);
}

function emas() {
  const tracker = createFiveMinuteEmaTracker();
  for (let i = 50; i >= 1; i -= 1) {
    tracker.append({
      asset: "btc",
      openTimeMs: WINDOW_START - i * 5 * 60_000,
      closeTimeMs: WINDOW_START - (i - 1) * 5 * 60_000,
      open: 99,
      high: 100,
      low: 98,
      close: 99,
    });
  }
  return new Map([["btc" as const, tracker]]);
}

function books(): BookCache {
  return new Map([
    [
      market.vendorRef,
      {
        market,
        up: { bestBid: 0.6, bestAsk: 0.61 },
        down: { bestBid: 0.1, bestAsk: 0.11 },
        fetchedAtMs: NOW - 100,
      },
    ],
  ]);
}

function placedOrder(overrides: Partial<PlacedOrder> = {}): PlacedOrder {
  return {
    orderId: "order-1",
    side: "up",
    outcomeRef: "UP",
    limitPrice: 0.6,
    sharesIfFilled: 33.33,
    feeRateBps: 0,
    placedAtMs: NOW,
    ...overrides,
  };
}

function emptyHydration(): MarketHydration {
  return {
    openOrder: null,
    side: null,
    outcomeRef: null,
    sharesFilled: 0,
    costUsd: 0,
    feesUsd: 0,
    feeRateBpsAvg: 0,
  };
}

function vendorWith({
  place,
  hydration = emptyHydration(),
}: {
  readonly place: () => Promise<PlacedOrder>;
  readonly hydration?: MarketHydration;
}): Vendor {
  return {
    id: "fake",
    walletAddress: "0xwallet",
    async discoverMarket() {
      return market;
    },
    async fetchBook() {
      throw new Error("not used");
    },
    async placeMakerLimitBuy() {
      return place();
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
      return hydration;
    },
    async scanLifetimePnl() {
      throw new Error("not used");
    },
  };
}

async function runPlacement({
  record,
  vendor,
  events,
}: {
  readonly record: AssetWindowRecord;
  readonly vendor: Vendor;
  readonly events: LiveEvent[];
}): Promise<void> {
  await placeWithRetry({
    asset: "btc",
    vendor,
    record,
    window: windowRecord(),
    lastTick: lastTick(),
    emas: emas(),
    books: books(),
    table,
    minEdge: 0.05,
    telegramBotToken: "token",
    telegramChatId: "chat",
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
  });
}

describe("placeWithRetry", () => {
  it("does not post a second order after an ambiguous generic error", async () => {
    const assetRecord = record();
    const events: LiveEvent[] = [];
    let placeCount = 0;

    await runPlacement({
      record: assetRecord,
      events,
      vendor: vendorWith({
        place: async () => {
          placeCount += 1;
          throw new Error("response timeout");
        },
      }),
    });

    expect(placeCount).toBe(1);
    expect(assetRecord.slot).toEqual({ kind: "empty" });
    expect(events.some((event) => event.kind === "error")).toBe(true);
  });

  it("reconciles an ambiguous placement error to the venue open order", async () => {
    const assetRecord = record();
    const events: LiveEvent[] = [];
    let placeCount = 0;

    await runPlacement({
      record: assetRecord,
      events,
      vendor: vendorWith({
        place: async () => {
          placeCount += 1;
          throw new Error("connection reset");
        },
        hydration: {
          openOrder: placedOrder(),
          side: "up",
          outcomeRef: "UP",
          sharesFilled: 0,
          costUsd: 0,
          feesUsd: 0,
          feeRateBpsAvg: 0,
        },
      }),
    });

    expect(placeCount).toBe(1);
    expect(assetRecord.slot).toMatchObject({
      kind: "active",
      orderId: "order-1",
      sharesIfFilled: 33.33,
    });
    expect(events.map((event) => event.kind)).toContain("order-placed");
  });

  it("preserves fills that arrive before the placement response returns", async () => {
    const assetRecord = record();
    const events: LiveEvent[] = [];

    await runPlacement({
      record: assetRecord,
      events,
      vendor: vendorWith({
        place: async () => {
          applyFill({
            asset: "btc",
            record: assetRecord,
            fill: { outcomeRef: "UP", price: 0.6, size: 3, feeRateBps: 0 },
            emit: (event) => events.push(event),
          });
          return placedOrder();
        },
      }),
    });

    expect(assetRecord.slot).toMatchObject({
      kind: "active",
      orderId: "order-1",
      sharesFilled: 3,
    });
    if (assetRecord.slot.kind === "active") {
      expect(assetRecord.slot.costUsd).toBeCloseTo(1.8, 9);
    }
  });
});
