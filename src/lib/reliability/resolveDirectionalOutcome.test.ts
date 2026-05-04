import { resolveDirectionalOutcome } from "@alea/lib/reliability/resolveDirectionalOutcome";
import { describe, expect, it } from "bun:test";

describe("resolveDirectionalOutcome", () => {
  it("resolves up when end is above start", () => {
    expect(resolveDirectionalOutcome({ startPrice: 100, endPrice: 101 })).toBe(
      "up",
    );
  });

  it("resolves down when end is below start", () => {
    expect(
      resolveDirectionalOutcome({ startPrice: 100, endPrice: 99.99 }),
    ).toBe("down");
  });

  it("ties favor up", () => {
    expect(resolveDirectionalOutcome({ startPrice: 100, endPrice: 100 })).toBe(
      "up",
    );
  });
});
