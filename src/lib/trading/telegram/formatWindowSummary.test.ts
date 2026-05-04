import {
  type AssetWindowOutcome,
  formatWindowSummary,
} from "@alea/lib/trading/telegram/formatWindowSummary";
import { describe, expect, it } from "bun:test";

const allNone: AssetWindowOutcome[] = (
  ["btc", "eth", "sol", "xrp", "doge"] as const
).map((asset) => ({ asset, kind: "none" }));

describe("formatWindowSummary", () => {
  it("uses the spec'd phrase when no asset traded", () => {
    expect(formatWindowSummary({ outcomes: allNone, totalPnlUsd: 0 })).toBe(
      [
        "No trades entered this market.",
        "",
        "Latest Window Pnl: $0.00",
        "",
        "Total Pnl: $0.00",
      ].join("\n"),
    );
  });

  it("lists each asset, separates window stats and lifetime total with blank lines", () => {
    const outcomes: AssetWindowOutcome[] = [
      {
        asset: "btc",
        kind: "traded",
        side: "up",
        fillPrice: 0.3,
        sharesFilled: 66.67,
        costUsd: 20,
        feesUsd: 0,
        netPnlUsd: 46.67,
        won: true,
      },
      {
        asset: "eth",
        kind: "unfilled",
        side: "down",
        limitPrice: 0.2,
      },
      { asset: "sol", kind: "none" },
      { asset: "xrp", kind: "none" },
      {
        asset: "doge",
        kind: "traded",
        side: "down",
        fillPrice: 0.4,
        sharesFilled: 50,
        costUsd: 20,
        feesUsd: 0,
        netPnlUsd: -20,
        won: false,
      },
    ];
    const text = formatWindowSummary({
      outcomes,
      totalPnlUsd: -116.54,
    });
    expect(text).toBe(
      [
        "BTC: ↑ @ $0.30 → won +$46.67",
        "ETH: ↓ @ $0.20 → didn't fill",
        "SOL: no trade",
        "XRP: no trade",
        "DOGE: ↓ @ $0.40 → lost -$20.00",
        "",
        "Latest Window Pnl: +$26.67",
        "",
        "Total Pnl: -$116.54",
      ].join("\n"),
    );
  });

  it("places cross-book rejections immediately under Latest Window Pnl", () => {
    const outcomes: AssetWindowOutcome[] = [
      {
        asset: "btc",
        kind: "traded",
        side: "up",
        fillPrice: 0.31,
        sharesFilled: 64.51,
        costUsd: 20,
        feesUsd: 0,
        netPnlUsd: 44.51,
        won: true,
      },
      { asset: "eth", kind: "none" },
      { asset: "sol", kind: "none" },
      { asset: "xrp", kind: "none" },
      { asset: "doge", kind: "none" },
    ];
    const text = formatWindowSummary({
      outcomes,
      stats: { rejectedCount: 5, placedAfterRetryCount: 2 },
      totalPnlUsd: 44.51,
    });
    expect(text).toBe(
      [
        "BTC: ↑ @ $0.31 → won +$44.51",
        "ETH: no trade",
        "SOL: no trade",
        "XRP: no trade",
        "DOGE: no trade",
        "",
        "Latest Window Pnl: +$44.51",
        "Cross-book rejections: 5 (2 placed after retry)",
        "",
        "Total Pnl: +$44.51",
      ].join("\n"),
    );
  });

  it("omits the parens when no rejection led to a placement", () => {
    const text = formatWindowSummary({
      outcomes: allNone,
      stats: { rejectedCount: 4, placedAfterRetryCount: 0 },
      totalPnlUsd: -50,
    });
    expect(text).toContain("Cross-book rejections: 4\n");
    expect(text).not.toContain("placed after retry");
  });

  it("omits the rejection line entirely when both counters are zero", () => {
    const text = formatWindowSummary({
      outcomes: allNone,
      stats: { rejectedCount: 0, placedAfterRetryCount: 0 },
      totalPnlUsd: 0,
    });
    expect(text).toBe(
      [
        "No trades entered this market.",
        "",
        "Latest Window Pnl: $0.00",
        "",
        "Total Pnl: $0.00",
      ].join("\n"),
    );
  });

  it("uses $0.00 (no sign) for an exactly-zero window pnl", () => {
    const outcomes: AssetWindowOutcome[] = [
      ...allNone.slice(0, 4),
      {
        asset: "doge",
        kind: "traded",
        side: "up",
        fillPrice: 0.5,
        sharesFilled: 40,
        costUsd: 20,
        feesUsd: 0,
        netPnlUsd: 0,
        won: false,
      },
    ];
    const text = formatWindowSummary({ outcomes, totalPnlUsd: -1.23 });
    expect(text).toContain("Latest Window Pnl: $0.00");
    expect(text.endsWith("Total Pnl: -$1.23")).toBe(true);
  });
});
