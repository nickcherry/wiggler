import { computePolymarketFeeUsd } from "@alea/lib/trading/vendor/polymarket/computePolymarketFeeUsd";
import { describe, expect, it } from "bun:test";

describe("computePolymarketFeeUsd", () => {
  it("uses Polymarket's symmetric price fee curve", () => {
    expect(
      computePolymarketFeeUsd({
        size: 100,
        price: 0.5,
        feeRateBps: 720,
      }),
    ).toBeCloseTo(1.8, 9);
    expect(
      computePolymarketFeeUsd({
        size: 100,
        price: 0.3,
        feeRateBps: 720,
      }),
    ).toBeCloseTo(1.512, 9);
    expect(
      computePolymarketFeeUsd({
        size: 100,
        price: 0.7,
        feeRateBps: 720,
      }),
    ).toBeCloseTo(1.512, 9);
  });

  it("rounds to five decimal places", () => {
    expect(
      computePolymarketFeeUsd({
        size: 1,
        price: 0.333333,
        feeRateBps: 123,
      }),
    ).toBe(0.00273);
  });

  it("returns zero for maker/no-fee or invalid fee inputs", () => {
    expect(
      computePolymarketFeeUsd({
        size: 100,
        price: 0.5,
        feeRateBps: 0,
      }),
    ).toBe(0);
    expect(
      computePolymarketFeeUsd({
        size: 100,
        price: 1,
        feeRateBps: 720,
      }),
    ).toBe(0);
  });
});
