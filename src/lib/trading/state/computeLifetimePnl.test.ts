import {
  computeLifetimePnl,
  type ScanMarketResolution,
  type ScanTrade,
} from "@alea/lib/trading/state/computeLifetimePnl";
import { describe, expect, it } from "bun:test";

const UP = "TOKEN_UP";
const DOWN = "TOKEN_DOWN";

function resolved({
  conditionId,
  winner,
}: {
  readonly conditionId: string;
  readonly winner: "up" | "down";
}): ScanMarketResolution {
  return {
    conditionId,
    resolved: true,
    outcomePriceByTokenId: new Map([
      [UP, winner === "up" ? 1 : 0],
      [DOWN, winner === "down" ? 1 : 0],
    ]),
  };
}

function buy({
  conditionId,
  tokenId,
  size,
  price,
  feeRateBps = 0,
}: {
  readonly conditionId: string;
  readonly tokenId: string;
  readonly size: number;
  readonly price: number;
  readonly feeRateBps?: number;
}): ScanTrade {
  return { conditionId, tokenId, side: "BUY", size, price, feeRateBps };
}

function sell({
  conditionId,
  tokenId,
  size,
  price,
  feeRateBps = 0,
}: {
  readonly conditionId: string;
  readonly tokenId: string;
  readonly size: number;
  readonly price: number;
  readonly feeRateBps?: number;
}): ScanTrade {
  return { conditionId, tokenId, side: "SELL", size, price, feeRateBps };
}

describe("computeLifetimePnl", () => {
  it("counts a single winning BUY as shares × $1 − cost", () => {
    const result = computeLifetimePnl({
      trades: [buy({ conditionId: "M1", tokenId: UP, size: 100, price: 0.3 })],
      resolutions: [resolved({ conditionId: "M1", winner: "up" })],
    });
    expect(result.lifetimePnlUsd).toBeCloseTo(70, 9);
    expect(result.resolvedMarketsCounted).toBe(1);
    expect(result.tradesCounted).toBe(1);
  });

  it("counts a single losing BUY as −cost", () => {
    const result = computeLifetimePnl({
      trades: [buy({ conditionId: "M1", tokenId: UP, size: 100, price: 0.3 })],
      resolutions: [resolved({ conditionId: "M1", winner: "down" })],
    });
    expect(result.lifetimePnlUsd).toBeCloseTo(-30, 9);
  });

  it("subtracts fees from PnL on both win and loss outcomes", () => {
    const winResult = computeLifetimePnl({
      trades: [
        buy({
          conditionId: "M1",
          tokenId: UP,
          size: 100,
          price: 0.3,
          feeRateBps: 100, // 1% on $30 cost = $0.30
        }),
      ],
      resolutions: [resolved({ conditionId: "M1", winner: "up" })],
    });
    expect(winResult.lifetimePnlUsd).toBeCloseTo(69.7, 9);

    const lossResult = computeLifetimePnl({
      trades: [
        buy({
          conditionId: "M1",
          tokenId: UP,
          size: 100,
          price: 0.3,
          feeRateBps: 100,
        }),
      ],
      resolutions: [resolved({ conditionId: "M1", winner: "down" })],
    });
    expect(lossResult.lifetimePnlUsd).toBeCloseTo(-30.3, 9);
  });

  it("treats SELL fills as positive cash flow that nets out inventory", () => {
    // Bought 100 shares at 0.30, then sold 60 of them at 0.50, then UP wins.
    // Inventory remaining: 40 shares at $1 payout = $40.
    // Cash flow: -100*0.30 + 60*0.50 = -30 + 30 = $0.
    // PnL = 0 + 40 - 0 fees = $40.
    const result = computeLifetimePnl({
      trades: [
        buy({ conditionId: "M1", tokenId: UP, size: 100, price: 0.3 }),
        sell({ conditionId: "M1", tokenId: UP, size: 60, price: 0.5 }),
      ],
      resolutions: [resolved({ conditionId: "M1", winner: "up" })],
    });
    expect(result.lifetimePnlUsd).toBeCloseTo(40, 9);
  });

  it("aggregates multiple markets independently", () => {
    const result = computeLifetimePnl({
      trades: [
        buy({ conditionId: "M1", tokenId: UP, size: 100, price: 0.3 }), // wins → +70
        buy({ conditionId: "M2", tokenId: DOWN, size: 50, price: 0.4 }), // loses → -20
        buy({ conditionId: "M3", tokenId: UP, size: 80, price: 0.2 }), // wins → +64
      ],
      resolutions: [
        resolved({ conditionId: "M1", winner: "up" }),
        resolved({ conditionId: "M2", winner: "up" }),
        resolved({ conditionId: "M3", winner: "up" }),
      ],
    });
    expect(result.lifetimePnlUsd).toBeCloseTo(70 + -20 + 64, 9);
    expect(result.resolvedMarketsCounted).toBe(3);
  });

  it("skips markets with no resolution and reports the count", () => {
    const result = computeLifetimePnl({
      trades: [
        buy({ conditionId: "M1", tokenId: UP, size: 100, price: 0.3 }),
        buy({ conditionId: "M2", tokenId: UP, size: 100, price: 0.3 }),
      ],
      resolutions: [
        resolved({ conditionId: "M1", winner: "up" }),
        // M2 unresolved
        {
          conditionId: "M2",
          resolved: false,
          outcomePriceByTokenId: new Map(),
        },
      ],
    });
    expect(result.lifetimePnlUsd).toBeCloseTo(70, 9);
    expect(result.resolvedMarketsCounted).toBe(1);
    expect(result.unresolvedMarketsSkipped).toBe(1);
    expect(result.tradesCounted).toBe(1);
  });

  it("skips trades for markets the resolver didn't return at all", () => {
    const result = computeLifetimePnl({
      trades: [
        buy({ conditionId: "M1", tokenId: UP, size: 100, price: 0.3 }),
        buy({ conditionId: "GHOST", tokenId: UP, size: 999, price: 0.5 }),
      ],
      resolutions: [resolved({ conditionId: "M1", winner: "up" })],
    });
    expect(result.lifetimePnlUsd).toBeCloseTo(70, 9);
    expect(result.unresolvedMarketsSkipped).toBe(1);
  });
});
