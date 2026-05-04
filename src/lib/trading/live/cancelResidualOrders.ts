import type { LiveEvent, WindowRecord } from "@alea/lib/trading/live/types";
import { labelAsset } from "@alea/lib/trading/live/utils";
import type { Vendor } from "@alea/lib/trading/vendor/types";

/**
 * Wraps up any unfilled portion of resting orders before window close.
 * Fires on the per-window cancel timer (T+5m − ORDER_CANCEL_MARGIN_MS)
 * and is best-effort: a "not_canceled / already filled" response is
 * treated as success because the slot is empty either way. The
 * cancel never blocks the wrap-up timer that fires shortly after.
 */
export async function cancelResidualOrders({
  window,
  vendor,
  emit,
}: {
  readonly window: WindowRecord;
  readonly vendor: Vendor;
  readonly emit: (event: LiveEvent) => void;
}): Promise<void> {
  for (const record of window.perAsset.values()) {
    if (record.slot.kind !== "active" || record.slot.orderId === null) {
      continue;
    }
    const orderId = record.slot.orderId;
    const result = await vendor.cancelOrder({ orderId });
    if (record.slot.kind === "active") {
      record.slot = {
        ...record.slot,
        orderId: null,
      };
    }
    emit({
      kind: result.accepted ? "info" : "warn",
      atMs: Date.now(),
      message: `${labelAsset(record.asset)} cancel ${orderId.slice(0, 10)}…: ${result.accepted ? "ok" : (result.errorMessage ?? "rejected")}`,
    });
  }
}
