import type { CancelResult } from "@alea/lib/trading/vendor/types";
import type { ClobClient } from "@polymarket/clob-client";
import { z } from "zod";

/**
 * Cancels one open order via the CLOB. Tolerates "already filled /
 * already cancelled" responses so the runner's wrap-up cleanup can
 * be called opportunistically without racing the venue's own
 * close-time cleanup. The runner treats both `accepted: true` and
 * `accepted: false` as "the slot is now empty"; the boolean is for
 * log lines.
 */
export async function cancelPolymarketOrder({
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
      return { accepted: true, errorMessage: null };
    }
    const inCancelled = parsed.data.canceled?.includes(orderId) ?? false;
    if (inCancelled) {
      return { accepted: true, errorMessage: null };
    }
    const reason = parsed.data.not_canceled?.[orderId];
    if (typeof reason === "string") {
      return { accepted: false, errorMessage: reason };
    }
    return { accepted: true, errorMessage: null };
  } catch (error) {
    return {
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
