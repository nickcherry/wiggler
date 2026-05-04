import { formatOrderError } from "@alea/lib/trading/telegram/formatOrderError";
import { describe, expect, it } from "bun:test";

describe("formatOrderError", () => {
  it("emits a one-line headline plus a retried-once footnote", () => {
    expect(
      formatOrderError({
        asset: "btc",
        side: "up",
        errorMessage: "venue 502 (request timeout)",
      }),
    ).toBe(
      [
        "Error placing BTC ↑ order: venue 502 (request timeout)",
        "",
        "(Retried once. Bot continues.)",
      ].join("\n"),
    );
  });

  it("uses down arrow for DOWN orders", () => {
    const text = formatOrderError({
      asset: "doge",
      side: "down",
      errorMessage: "signing failed",
    });
    expect(text.split("\n")[0]).toBe(
      "Error placing DOGE ↓ order: signing failed",
    );
  });

  it("can describe an ambiguous error that was reconciled instead of retried", () => {
    expect(
      formatOrderError({
        asset: "eth",
        side: "up",
        errorMessage: "response body lost",
        retried: false,
      }),
    ).toContain("Reconciled venue state before giving up");
  });
});
