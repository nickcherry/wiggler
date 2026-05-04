import { cancelPolymarketOrder } from "@alea/lib/trading/vendor/polymarket/cancelOrder";
import type { ClobClient, OrderPayload } from "@polymarket/clob-client";
import { describe, expect, it } from "bun:test";

function clientWithCancel(
  cancelOrder: (payload: OrderPayload) => Promise<unknown>,
): ClobClient {
  return { cancelOrder } as unknown as ClobClient;
}

describe("cancelPolymarketOrder", () => {
  it("reports accepted when the order id appears in the canceled list", async () => {
    const seen: OrderPayload[] = [];
    const result = await cancelPolymarketOrder({
      client: clientWithCancel(async (payload) => {
        seen.push(payload);
        return { canceled: ["order-1"], not_canceled: {} };
      }),
      orderId: "order-1",
    });

    expect(seen).toEqual([{ orderID: "order-1" }]);
    expect(result).toEqual({
      accepted: true,
      terminal: true,
      errorMessage: null,
    });
  });

  it("returns the venue not_canceled reason when present", async () => {
    const result = await cancelPolymarketOrder({
      client: clientWithCancel(async () => ({
        canceled: [],
        not_canceled: { "order-1": "already filled" },
      })),
      orderId: "order-1",
    });

    expect(result).toEqual({
      accepted: false,
      terminal: true,
      errorMessage: "already filled",
    });
  });

  it("treats unexpected success response shapes as accepted", async () => {
    const result = await cancelPolymarketOrder({
      client: clientWithCancel(async () => ({ ok: true })),
      orderId: "order-1",
    });

    expect(result).toEqual({
      accepted: true,
      terminal: true,
      errorMessage: null,
    });
  });

  it("converts thrown client errors into rejected cancel results", async () => {
    const result = await cancelPolymarketOrder({
      client: clientWithCancel(async () => {
        throw new Error("network down");
      }),
      orderId: "order-1",
    });

    expect(result).toEqual({
      accepted: false,
      terminal: false,
      errorMessage: "network down",
    });
  });
});
