import { formatOrderPlaced } from "@alea/lib/trading/telegram/formatOrderPlaced";
import { describe, expect, it } from "bun:test";

describe("formatOrderPlaced", () => {
  it("matches the spec'd shape for an UP BTC order", () => {
    const text = formatOrderPlaced({
      asset: "btc",
      side: "up",
      stakeUsd: 20,
      underlyingPrice: 80_251.35,
      linePrice: 80_253.1,
      windowEndMs: 1_777_867_500_000,
      nowMs: 1_777_867_500_000 - (2 * 60_000 + 20_000),
    });
    expect(text).toBe(
      [
        "Placed order for $20 of BTC ↑ @ $80,251.35",
        "",
        "Price line is $80,253.10 (+0.002%)",
        "Market expires in 2 minutes 20 seconds.",
      ].join("\n"),
    );
  });

  it("uses down arrow for DOWN bets and 5-decimal precision for DOGE", () => {
    const text = formatOrderPlaced({
      asset: "doge",
      side: "down",
      stakeUsd: 20,
      underlyingPrice: 0.18234,
      linePrice: 0.18241,
      windowEndMs: 5 * 60 * 1000,
      nowMs: 5 * 60 * 1000 - 60_000,
    });
    const firstLine = text.split("\n")[0] ?? "";
    expect(firstLine).toBe("Placed order for $20 of DOGE ↓ @ $0.18234");
    expect(text).toContain("Price line is $0.18241 (+0.038%)");
    expect(text).toContain("Market expires in 1 minute");
  });

  it("renders a negative percent when the line is below the current price", () => {
    const text = formatOrderPlaced({
      asset: "btc",
      side: "up",
      stakeUsd: 20,
      underlyingPrice: 80_300,
      linePrice: 80_270, // ≈ −0.0374%
      windowEndMs: 60_000,
      nowMs: 0,
    });
    expect(text).toContain("Price line is $80,270.00 (-0.037%)");
  });

  it("renders +0.0% when current and line agree exactly", () => {
    const text = formatOrderPlaced({
      asset: "btc",
      side: "up",
      stakeUsd: 20,
      underlyingPrice: 80_000,
      linePrice: 80_000,
      windowEndMs: 60_000,
      nowMs: 0,
    });
    expect(text).toContain("Price line is $80,000.00 (+0.0%)");
  });

  it("strips trailing zeros down to one decimal but never further", () => {
    // 0.02% (linePrice = current * 1.0002)
    const text = formatOrderPlaced({
      asset: "btc",
      side: "up",
      stakeUsd: 20,
      underlyingPrice: 80_000,
      linePrice: 80_016, // exactly +0.02%
      windowEndMs: 60_000,
      nowMs: 0,
    });
    expect(text).toContain("Price line is $80,016.00 (+0.02%)");
  });

  it("formats sub-minute expiries in seconds, plural-aware", () => {
    const text = formatOrderPlaced({
      asset: "eth",
      side: "up",
      stakeUsd: 20,
      underlyingPrice: 2_388.5,
      linePrice: 2_388.5,
      windowEndMs: 60_000,
      nowMs: 60_000 - 1_000,
    });
    expect(text).toContain("Market expires in 1 second.");

    const text2 = formatOrderPlaced({
      asset: "eth",
      side: "up",
      stakeUsd: 20,
      underlyingPrice: 2_388.5,
      linePrice: 2_388.5,
      windowEndMs: 60_000,
      nowMs: 60_000 - 30_000,
    });
    expect(text2).toContain("Market expires in 30 seconds.");
  });
});
