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
    expect(formatWindowSummary({ outcomes: allNone })).toBe(
      ["No trades entered this market.", "", "Total Pnl: $0.00"].join("\n"),
    );
  });

  it("lists each asset in the order passed in, with a total pnl tail", () => {
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
    const text = formatWindowSummary({ outcomes });
    expect(text).toBe(
      [
        "BTC: ↑ @ $0.30 → won +$46.67",
        "ETH: ↓ @ $0.20 → didn't fill",
        "SOL: no trade",
        "XRP: no trade",
        "DOGE: ↓ @ $0.40 → lost -$20.00",
        "",
        "Total Pnl: +$26.67",
      ].join("\n"),
    );
  });

  it("computes Total Pnl net of fees", () => {
    const outcomes: AssetWindowOutcome[] = [
      {
        asset: "btc",
        kind: "traded",
        side: "up",
        fillPrice: 0.5,
        sharesFilled: 40,
        costUsd: 20,
        feesUsd: 0.4,
        netPnlUsd: 19.6,
        won: true,
      },
      { asset: "eth", kind: "none" },
      { asset: "sol", kind: "none" },
      { asset: "xrp", kind: "none" },
      { asset: "doge", kind: "none" },
    ];
    const text = formatWindowSummary({ outcomes });
    expect(text.endsWith("Total Pnl: +$19.60")).toBe(true);
  });

  it("uses $0.00 (no sign) for an exactly-zero total", () => {
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
    const text = formatWindowSummary({ outcomes });
    expect(text.endsWith("Total Pnl: $0.00")).toBe(true);
  });
});
