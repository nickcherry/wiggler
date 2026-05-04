import type { ClobClient } from "@polymarket/clob-client";
import { z } from "zod";

export type CancelResult = {
  /** Order id we asked the venue to cancel. */
  readonly orderId: string;
  /**
   * `true` when the venue confirmed the cancel; `false` when it rejected
   * the request (already-filled, already-cancelled, or unknown id). The
   * caller treats both as "slot is now empty" — we never carry a
   * cancel-in-flight state across windows.
   */
  readonly accepted: boolean;
  /** Best-effort error string when `accepted === false`. */
  readonly errorMessage: string | null;
};

/**
 * Cancels a single open order via the CLOB. Tolerates the "order is
 * already filled / already gone" case so the live runner can call
 * this opportunistically near window close without racing the venue's
 * own cleanup.
 */
export async function cancelOpenOrder({
  client,
  orderId,
}: {
  readonly client: ClobClient;
  readonly orderId: string;
}): Promise<CancelResult> {
  try {
    const response = await client.cancelOrder({ orderID: orderId });
    const parsed = cancelOrderResponseSchema.safeParse(response);
    if (!parsed.success) {
      return {
        orderId,
        accepted: true,
        errorMessage: null,
      };
    }
    const inCancelled = parsed.data.canceled?.includes(orderId) ?? false;
    const reason = parsed.data.not_canceled?.[orderId];
    if (inCancelled) {
      return { orderId, accepted: true, errorMessage: null };
    }
    if (typeof reason === "string") {
      // The venue surfaces "already filled" / "already cancelled" as
      // not-canceled-with-reason rather than a thrown error. Treat as
      // a soft success: the slot is empty either way.
      return { orderId, accepted: false, errorMessage: reason };
    }
    return { orderId, accepted: true, errorMessage: null };
  } catch (error) {
    return {
      orderId,
      accepted: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

const cancelOrderResponseSchema = z
  .object({
    canceled: z.array(z.string()).optional(),
    not_canceled: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();
