import { placePolymarketMakerLimitBuy } from "@alea/lib/trading/vendor/polymarket/placeMakerLimitBuy";
import {
  PostOnlyRejectionError,
  type TradableMarket,
} from "@alea/lib/trading/vendor/types";
import {
  type ClobClient,
  type CreateOrderOptions,
  OrderType,
  Side,
  type SignedOrder,
  type UserOrder,
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

function signedOrder(): SignedOrder {
  return {
    salt: 1,
    maker: "0xmaker",
    signer: "0xsigner",
    taker: "0x0000000000000000000000000000000000000000",
    tokenId: "UP_TOKEN",
    makerAmount: "100",
    takerAmount: "50",
    expiration: "0",
    nonce: "0",
    feeRateBps: "0",
    side: Side.BUY,
    signature: "0xsig",
  } as unknown as SignedOrder;
}

describe("placePolymarketMakerLimitBuy", () => {
  it("creates and posts a post-only GTC buy using rounded venue price and shares", async () => {
    const signed = signedOrder();
    const createCalls: Array<{
      readonly order: UserOrder;
      readonly options: Partial<CreateOrderOptions> | undefined;
    }> = [];
    const postCalls: Array<{
      readonly order: SignedOrder;
      readonly orderType: OrderType | undefined;
      readonly deferExec: boolean | undefined;
      readonly postOnly: boolean | undefined;
    }> = [];
    const client = {
      async createOrder(
        order: UserOrder,
        options?: Partial<CreateOrderOptions>,
      ): Promise<SignedOrder> {
        createCalls.push({ order, options });
        return signed;
      },
      async postOrder(
        order: SignedOrder,
        orderType?: OrderType,
        deferExec?: boolean,
        postOnly?: boolean,
      ): Promise<unknown> {
        postCalls.push({ order, orderType, deferExec, postOnly });
        return {
          success: true,
          orderID: "0xorder",
          transactionsHashes: [],
          status: "live",
          takingAmount: "4000",
          makingAmount: "2000",
        };
      },
    } as unknown as ClobClient;

    const placed = await placePolymarketMakerLimitBuy({
      client,
      market,
      side: "down",
      limitPrice: 0.333,
      stakeUsd: 20,
      negRisk: true,
    });

    expect(createCalls).toEqual([
      {
        order: {
          tokenID: "DOWN_TOKEN",
          price: 0.33,
          size: 60.6,
          side: Side.BUY,
          feeRateBps: 0,
        },
        options: { negRisk: true },
      },
    ]);
    expect(postCalls).toEqual([
      {
        order: signed,
        orderType: OrderType.GTC,
        deferExec: false,
        postOnly: true,
      },
    ]);
    expect(placed).toMatchObject({
      orderId: "0xorder",
      side: "down",
      outcomeRef: "DOWN_TOKEN",
      limitPrice: 0.33,
      sharesIfFilled: 60.6,
      feeRateBps: 0,
    });
    expect(placed.placedAtMs).toBeGreaterThan(0);
  });

  it("translates venue post-only rejection phrases into PostOnlyRejectionError", async () => {
    const client = {
      async createOrder(): Promise<SignedOrder> {
        return signedOrder();
      },
      async postOrder(): Promise<unknown> {
        return {
          success: false,
          errorMsg: "post only order would match resting liquidity",
        };
      },
    } as unknown as ClobClient;

    expect(
      placePolymarketMakerLimitBuy({
        client,
        market,
        side: "up",
        limitPrice: 0.52,
        stakeUsd: 20,
        negRisk: false,
      }),
    ).rejects.toThrow(PostOnlyRejectionError);
  });

  it("surfaces non-post-only venue rejections as generic errors", () => {
    const client = {
      async createOrder(): Promise<SignedOrder> {
        return signedOrder();
      },
      async postOrder(): Promise<unknown> {
        return { success: false, errorMsg: "insufficient allowance" };
      },
    } as unknown as ClobClient;

    expect(
      placePolymarketMakerLimitBuy({
        client,
        market,
        side: "up",
        limitPrice: 0.52,
        stakeUsd: 20,
        negRisk: false,
      }),
    ).rejects.toThrow(/postOrder rejected: insufficient allowance/);
  });

  it("rejects invalid limit prices before creating an order", () => {
    const client = {
      async createOrder(): Promise<SignedOrder> {
        throw new Error("should not be called");
      },
      async postOrder(): Promise<unknown> {
        throw new Error("should not be called");
      },
    } as unknown as ClobClient;

    expect(
      placePolymarketMakerLimitBuy({
        client,
        market,
        side: "up",
        limitPrice: 1,
        stakeUsd: 20,
        negRisk: false,
      }),
    ).rejects.toThrow(/limitPrice must be in \(0, 1\)/);
  });
});
