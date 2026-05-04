import { hydratePolymarketMarketState } from "@alea/lib/trading/vendor/polymarket/hydrateMarketState";
import type { TradableMarket } from "@alea/lib/trading/vendor/types";
import {
  type ClobClient,
  type OpenOrder,
  Side,
  type Trade,
} from "@polymarket/clob-client";
import { describe, expect, it } from "bun:test";

const market: TradableMarket = {
  asset: "btc",
  windowStartUnixSeconds: 1_777_900_200,
  windowStartMs: 1_777_900_200_000,
  windowEndMs: 1_777_900_500_000,
  vendorRef: "condition",
  upRef: "UP_TOKEN",
  downRef: "DOWN_TOKEN",
  acceptingOrders: true,
};

function openOrder(overrides: Partial<OpenOrder>): OpenOrder {
  return {
    id: "order",
    status: "LIVE",
    owner: "0xowner",
    maker_address: "0xmaker",
    market: market.vendorRef,
    asset_id: "UP_TOKEN",
    side: "BUY",
    original_size: "10",
    size_matched: "0",
    price: "0.42",
    associate_trades: [],
    outcome: "Up",
    created_at: 1_777_900_210,
    expiration: "0",
    order_type: "GTC",
    ...overrides,
  };
}

function trade(overrides: Partial<Trade>): Trade {
  return {
    id: "trade",
    taker_order_id: "taker",
    market: market.vendorRef,
    asset_id: "UP_TOKEN",
    side: Side.BUY,
    size: "2",
    fee_rate_bps: "10",
    price: "0.5",
    status: "MATCHED",
    match_time: "1777900212",
    last_update: "1777900213",
    outcome: "Up",
    bucket_index: 0,
    owner: "0xowner",
    maker_address: "0xmaker",
    maker_orders: [],
    transaction_hash: "0xhash",
    trader_side: "MAKER",
    ...overrides,
  };
}

function clientWith({
  openOrders,
  trades,
}: {
  readonly openOrders: readonly OpenOrder[];
  readonly trades: readonly Trade[];
}): ClobClient {
  return {
    async getOpenOrders(params: { readonly market?: string }) {
      expect(params).toEqual({ market: market.vendorRef });
      return openOrders;
    },
    async getTrades(params: { readonly market?: string }) {
      expect(params).toEqual({ market: market.vendorRef });
      return trades;
    },
  } as unknown as ClobClient;
}

describe("hydratePolymarketMarketState", () => {
  it("selects the newest valid BUY order and aggregates matching fills", async () => {
    const result = await hydratePolymarketMarketState({
      client: clientWith({
        openOrders: [
          openOrder({ id: "old", created_at: 100, price: "0.4" }),
          openOrder({ id: "sell", created_at: 300, side: "SELL" }),
          openOrder({
            id: "new",
            created_at: 200,
            asset_id: "DOWN_TOKEN",
            original_size: "15",
            price: "0.37",
          }),
        ],
        trades: [
          trade({
            asset_id: "DOWN_TOKEN",
            size: "3",
            price: "0.4",
            fee_rate_bps: "20",
          }),
          trade({
            asset_id: "DOWN_TOKEN",
            size: "2",
            price: "0.5",
            fee_rate_bps: "40",
          }),
          trade({ asset_id: "OTHER", size: "99", price: "0.01" }),
        ],
      }),
      market,
    });

    expect(result.openOrder).toMatchObject({
      orderId: "new",
      side: "down",
      outcomeRef: "DOWN_TOKEN",
      limitPrice: 0.37,
      sharesIfFilled: 15,
      feeRateBps: 0,
      placedAtMs: 200_000,
    });
    expect(result).toMatchObject({
      side: "down",
      outcomeRef: "DOWN_TOKEN",
      sharesFilled: 5,
      costUsd: 2.2,
      feeRateBpsAvg: 28,
    });
  });

  it("hydrates partial fills even when no open order remains", async () => {
    const result = await hydratePolymarketMarketState({
      client: clientWith({
        openOrders: [],
        trades: [trade({ asset_id: "UP_TOKEN", size: "4", price: "0.25" })],
      }),
      market,
    });

    expect(result).toMatchObject({
      openOrder: null,
      side: "up",
      outcomeRef: "UP_TOKEN",
      sharesFilled: 4,
      costUsd: 1,
      feeRateBpsAvg: 10,
    });
  });

  it("returns neutral hydration when venue state has no usable order or fill", async () => {
    const result = await hydratePolymarketMarketState({
      client: clientWith({
        openOrders: [openOrder({ asset_id: "OTHER" })],
        trades: [trade({ asset_id: "UP_TOKEN", size: "bad", price: "0.4" })],
      }),
      market,
    });

    expect(result).toEqual({
      openOrder: null,
      side: null,
      outcomeRef: null,
      sharesFilled: 0,
      costUsd: 0,
      feeRateBpsAvg: 0,
    });
  });
});
