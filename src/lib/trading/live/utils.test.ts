import { decimalsFor, labelAsset } from "@alea/lib/trading/live/utils";
import { describe, expect, it } from "bun:test";

describe("trading live utils", () => {
  it("formats fixed-width uppercase asset labels", () => {
    expect(labelAsset("btc")).toBe("BTC  ");
    expect(labelAsset("doge")).toBe("DOGE ");
  });

  it("uses per-asset price precision for live logs", () => {
    expect(decimalsFor({ asset: "btc" })).toBe(2);
    expect(decimalsFor({ asset: "eth" })).toBe(2);
    expect(decimalsFor({ asset: "sol" })).toBe(4);
    expect(decimalsFor({ asset: "xrp" })).toBe(4);
    expect(decimalsFor({ asset: "doge" })).toBe(5);
  });
});
