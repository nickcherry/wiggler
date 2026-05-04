import type { LiveEvent, WindowRecord } from "@alea/lib/trading/live/types";
import { labelAsset, sleep } from "@alea/lib/trading/live/utils";
import type { Vendor } from "@alea/lib/trading/vendor/types";

const CANCEL_MAX_ATTEMPTS = 3;
const CANCEL_RETRY_DELAY_MS = 250;

/**
 * Wraps up any unfilled portion of resting orders before window close.
 * Fires on the per-window cancel timer (T+5m − ORDER_CANCEL_MARGIN_MS)
 * and is best-effort. Terminal venue responses ("already filled",
 * "already cancelled") clear the local order id; transient failures
 * keep it so wrap-up can still see unresolved exposure.
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
    let result = await vendor.cancelOrder({ orderId });
    for (
      let attempt = 1;
      attempt < CANCEL_MAX_ATTEMPTS && !result.accepted && !result.terminal;
      attempt += 1
    ) {
      await sleep(CANCEL_RETRY_DELAY_MS);
      result = await vendor.cancelOrder({ orderId });
    }
    const cleared = result.accepted || result.terminal;
    if (cleared && record.slot.kind === "active") {
      record.slot = {
        ...record.slot,
        orderId: null,
      };
    }
    emit({
      kind: cleared ? "info" : "warn",
      atMs: Date.now(),
      message: `${labelAsset(record.asset)} cancel ${orderId.slice(0, 10)}…: ${result.accepted ? "ok" : result.terminal ? `terminal: ${result.errorMessage ?? "already closed"}` : (result.errorMessage ?? "failed")}`,
    });
  }
}
