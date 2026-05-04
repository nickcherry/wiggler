import {
  placePolymarketMakerLimitBuy,
  preparePolymarketMakerLimitBuy,
} from "@alea/lib/trading/vendor/polymarket/placeMakerLimitBuy";
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
  type UserOrderV2,
} from "@polymarket/clob-client-v2";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const originalDateNow = Date.now;

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

const constraints = {
  priceTickSize: 0.01,
  tickSize: "0.01" as const,
  minOrderSize: 1,
  minimumOrderAgeSeconds: 0,
  makerBaseFeeBps: 0,
  takerBaseFeeBps: 720,
  feesTakerOnly: true,
  negRisk: true,
  rfqEnabled: false,
  takerOrderDelayEnabled: false,
};

const expireBeforeMs = market.windowEndMs - 10_000;

function signedOrder(): SignedOrder {
  return {
    salt: 1,
    maker: "0xmaker",
    signer: "0xsigner",
    tokenId: "UP_TOKEN",
    makerAmount: "100",
    takerAmount: "50",
    expiration: "0",
    side: Side.BUY,
    signatureType: 2,
    timestamp: "1777900210000",
    metadata:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    builder:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    signature: "0xsig",
  } as unknown as SignedOrder;
}

describe("placePolymarketMakerLimitBuy", () => {
  beforeEach(() => {
    Date.now = () => market.windowStartMs + 120_000;
  });

  afterEach(() => {
    Date.now = originalDateNow;
  });

  it("creates and posts a post-only GTD buy using venue tick, size, and expiration", async () => {
    const signed = signedOrder();
    const createCalls: Array<{
      readonly order: UserOrderV2;
      readonly options: Partial<CreateOrderOptions> | undefined;
    }> = [];
    const postCalls: Array<{
      readonly order: SignedOrder;
      readonly orderType: OrderType | undefined;
      readonly postOnly: boolean | undefined;
      readonly deferExec: boolean | undefined;
    }> = [];
    const client = {
      async createOrder(
        order: UserOrderV2,
        options?: Partial<CreateOrderOptions>,
      ): Promise<SignedOrder> {
        createCalls.push({ order, options });
        return signed;
      },
      async postOrder(
        order: SignedOrder,
        orderType?: OrderType,
        postOnly?: boolean,
        deferExec?: boolean,
      ): Promise<unknown> {
        postCalls.push({ order, orderType, deferExec, postOnly });
        return {
          success: true,
          errorMsg: "",
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
      expireBeforeMs,
      constraints,
    });

    expect(createCalls).toEqual([
      {
        order: {
          tokenID: "DOWN_TOKEN",
          price: 0.33,
          size: 60.6,
          side: Side.BUY,
          expiration: 1_777_900_490,
        },
        options: { negRisk: true, tickSize: "0.01" },
      },
    ]);
    expect(postCalls).toEqual([
      {
        order: signed,
        orderType: OrderType.GTD,
        postOnly: true,
        deferExec: false,
      },
    ]);
    expect(placed).toMatchObject({
      orderId: "0xorder",
      side: "down",
      outcomeRef: "DOWN_TOKEN",
      limitPrice: 0.33,
      sharesIfFilled: 60.6,
      feeRateBps: 0,
      orderType: "GTD",
      expiresAtMs: expireBeforeMs,
    });
    expect(placed.placedAtMs).toBeGreaterThan(0);
  });

  it("prepares the same maker GTD order shape without signing or posting", () => {
    const prepared = preparePolymarketMakerLimitBuy({
      market,
      side: "down",
      limitPrice: 0.333,
      stakeUsd: 20,
      expireBeforeMs,
      constraints,
    });

    expect(prepared).toMatchObject({
      side: "down",
      outcomeRef: "DOWN_TOKEN",
      limitPrice: 0.33,
      sharesIfFilled: 60.6,
      feeRateBps: 0,
      orderType: "GTD",
      expiresAtMs: expireBeforeMs,
    });
    expect(prepared.preparedAtMs).toBe(Date.now());
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
        expireBeforeMs,
        constraints: { ...constraints, negRisk: false },
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
        expireBeforeMs,
        constraints: { ...constraints, negRisk: false },
      }),
    ).rejects.toThrow(/postOrder rejected: insufficient allowance/);
  });

  it("surfaces V2 error-only venue responses as generic errors", () => {
    const client = {
      async createOrder(): Promise<SignedOrder> {
        return signedOrder();
      },
      async postOrder(): Promise<unknown> {
        return { error: "Trading restricted in your region", status: 403 };
      },
    } as unknown as ClobClient;

    expect(
      placePolymarketMakerLimitBuy({
        client,
        market,
        side: "up",
        limitPrice: 0.52,
        stakeUsd: 20,
        expireBeforeMs,
        constraints: { ...constraints, negRisk: false },
      }),
    ).rejects.toThrow(/postOrder rejected: Trading restricted in your region/);
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
        expireBeforeMs,
        constraints: { ...constraints, negRisk: false },
      }),
    ).rejects.toThrow(/limitPrice must be in \(0, 1\)/);
  });

  it("rejects orders below the venue minimum size", () => {
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
        limitPrice: 0.99,
        stakeUsd: 1,
        expireBeforeMs,
        constraints: { ...constraints, minOrderSize: 5 },
      }),
    ).rejects.toThrow(/below venue minimum/);
  });

  it("rejects GTD orders too close to expiration before signing", () => {
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
        limitPrice: 0.5,
        stakeUsd: 20,
        expireBeforeMs: Date.now() + 30_000,
        constraints,
      }),
    ).rejects.toThrow(/not enough time before GTD expiry/);
  });
});
