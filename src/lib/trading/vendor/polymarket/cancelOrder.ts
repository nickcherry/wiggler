import type { CancelResult } from "@alea/lib/trading/vendor/types";
import type { ClobClient } from "@polymarket/clob-client-v2";
import { z } from "zod";

/**
 * Cancels one open order via the CLOB. Tolerates "already filled /
 * already cancelled" responses so the runner's wrap-up cleanup can
 * be called opportunistically without racing the venue's own
 * close-time cleanup. Network/client failures are not terminal: the
 * runner keeps tracking the order id so it can retry or reconcile.
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
      return { accepted: true, terminal: true, errorMessage: null };
    }
    const inCancelled = parsed.data.canceled?.includes(orderId) ?? false;
    if (inCancelled) {
      return { accepted: true, terminal: true, errorMessage: null };
    }
    const reason = parsed.data.not_canceled?.[orderId];
    if (typeof reason === "string") {
      return {
        accepted: false,
        terminal: isTerminalNotCanceledReason({ reason }),
        errorMessage: reason,
      };
    }
    return { accepted: true, terminal: true, errorMessage: null };
  } catch (error) {
    return {
      accepted: false,
      terminal: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

function isTerminalNotCanceledReason({
  reason,
}: {
  readonly reason: string;
}): boolean {
  const lower = reason.toLowerCase();
  return (
    lower.includes("already") ||
    lower.includes("filled") ||
    lower.includes("matched") ||
    lower.includes("cancelled") ||
    lower.includes("canceled") ||
    lower.includes("not found")
  );
}

const cancelOrderResponseSchema = z
  .object({
    canceled: z.array(z.string()).optional(),
    not_canceled: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();
