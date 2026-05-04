import { settleFilled } from "@alea/lib/trading/state/settleFilled";
import type { AssetSlot } from "@alea/lib/trading/state/types";
import { describe, expect, it } from "bun:test";

const baseMarket = {
  asset: "btc" as const,
  windowStartUnixSeconds: 1_777_867_200,
  windowStartMs: 1_777_867_200_000,
  windowEndMs: 1_777_867_500_000,
  slug: "btc-updown-5m-1777867200",
  conditionId: "0xabc",
  upYesTokenId: "TOKEN_UP",
  downYesTokenId: "TOKEN_DOWN",
  negRisk: false,
  acceptingOrders: false,
};

function active({
  side,
  sharesFilled,
  costUsd,
  feeRateBpsAvg,
  limitPrice,
  orderId = null,
}: {
  readonly side: "up" | "down";
  readonly sharesFilled: number;
  readonly costUsd: number;
  readonly feeRateBpsAvg: number;
  readonly limitPrice: number;
  readonly orderId?: string | null;
}): Extract<AssetSlot, { kind: "active" }> {
  return {
    kind: "active",
    market: baseMarket,
    side,
    tokenId: side === "up" ? "TOKEN_UP" : "TOKEN_DOWN",
    orderId,
    limitPrice,
    sharesFilled,
    costUsd,
    feeRateBpsAvg,
  };
}

describe("settleFilled", () => {
  it("books a profit when the bet side matches final outcome", () => {
    const settled = settleFilled({
      active: active({
        side: "up",
        sharesFilled: 100,
        costUsd: 30,
        feeRateBpsAvg: 0,
        limitPrice: 0.3,
      }),
      finalPrice: 80_500,
      line: 80_400,
    });
    expect(settled.kind).toBe("settled");
    if (settled.kind !== "settled") {
      return;
    }
    expect(settled.won).toBe(true);
    expect(settled.grossPnlUsd).toBeCloseTo(70, 9);
    expect(settled.feesUsd).toBe(0);
    expect(settled.netPnlUsd).toBeCloseTo(70, 9);
    expect(settled.fillPriceAvg).toBeCloseTo(0.3, 9);
  });

  it("books a loss equal to cost when the bet side loses", () => {
    const settled = settleFilled({
      active: active({
        side: "down",
        sharesFilled: 50,
        costUsd: 20,
        feeRateBpsAvg: 0,
        limitPrice: 0.4,
      }),
      finalPrice: 80_500,
      line: 80_400,
    });
    expect(settled.kind).toBe("settled");
    if (settled.kind !== "settled") {
      return;
    }
    expect(settled.won).toBe(false);
    expect(settled.grossPnlUsd).toBeCloseTo(-20, 9);
    expect(settled.feesUsd).toBe(0);
    expect(settled.netPnlUsd).toBeCloseTo(-20, 9);
  });

  it("subtracts maker fee from PnL on both win and loss outcomes", () => {
    const winSettled = settleFilled({
      active: active({
        side: "up",
        sharesFilled: 100,
        costUsd: 30,
        feeRateBpsAvg: 100, // 1% fee
        limitPrice: 0.3,
      }),
      finalPrice: 80_500,
      line: 80_400,
    });
    expect(winSettled.kind).toBe("settled");
    if (winSettled.kind === "settled") {
      expect(winSettled.feesUsd).toBeCloseTo(0.3, 9);
      expect(winSettled.netPnlUsd).toBeCloseTo(69.7, 9);
    }

    const lossSettled = settleFilled({
      active: active({
        side: "down",
        sharesFilled: 100,
        costUsd: 30,
        feeRateBpsAvg: 100,
        limitPrice: 0.3,
      }),
      finalPrice: 80_500,
      line: 80_400,
    });
    expect(lossSettled.kind).toBe("settled");
    if (lossSettled.kind === "settled") {
      expect(lossSettled.feesUsd).toBeCloseTo(0.3, 9);
      expect(lossSettled.netPnlUsd).toBeCloseTo(-30.3, 9);
    }
  });

  it("treats finalPrice exactly at line as an UP win (tie-break)", () => {
    const settled = settleFilled({
      active: active({
        side: "up",
        sharesFilled: 1,
        costUsd: 0.5,
        feeRateBpsAvg: 0,
        limitPrice: 0.5,
      }),
      finalPrice: 80_400,
      line: 80_400,
    });
    expect(settled.kind).toBe("settled");
    if (settled.kind === "settled") {
      expect(settled.won).toBe(true);
    }
  });

  it("returns noFill when active had zero fills", () => {
    const result = settleFilled({
      active: active({
        side: "up",
        sharesFilled: 0,
        costUsd: 0,
        feeRateBpsAvg: 0,
        limitPrice: 0.45,
      }),
      finalPrice: 80_500,
      line: 80_400,
    });
    expect(result.kind).toBe("noFill");
    if (result.kind === "noFill") {
      expect(result.side).toBe("up");
      expect(result.limitPrice).toBe(0.45);
    }
  });
});
