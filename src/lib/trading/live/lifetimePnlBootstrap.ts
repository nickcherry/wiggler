import type { LifetimePnlBox, LiveEvent } from "@alea/lib/trading/live/types";
import {
  loadLifetimePnl,
  persistLifetimePnl,
} from "@alea/lib/trading/state/lifetimePnlStore";
import type { Vendor } from "@alea/lib/trading/vendor/types";

/**
 * Boot-time lifetime PnL hydration. Loads the on-disk checkpoint if
 * it matches the running wallet; otherwise falls back to a vendor-
 * side trade-history scan so `Total Pnl` is *truly* lifetime, not
 * just since-process-start.
 *
 * Always returns — failures are logged but the runner proceeds with
 * whatever value the bootstrap could produce (zero if all paths
 * fail).
 */
export async function bootstrapLifetimePnl({
  vendor,
  lifetimePnl,
  emit,
}: {
  readonly vendor: Vendor;
  readonly lifetimePnl: LifetimePnlBox;
  readonly emit: (event: LiveEvent) => void;
}): Promise<void> {
  const loaded = await loadLifetimePnl({ walletAddress: vendor.walletAddress });
  if (loaded.source === "loaded") {
    lifetimePnl.value = loaded.lifetimePnlUsd;
    emit({
      kind: "info",
      atMs: Date.now(),
      message: `lifetime pnl loaded: $${loaded.lifetimePnlUsd.toFixed(2)} (as-of ${new Date(loaded.asOfMs).toISOString()})`,
    });
    return;
  }
  emit({
    kind: "info",
    atMs: Date.now(),
    message: `lifetime pnl checkpoint ${loaded.reason}; scanning ${vendor.id} trade history…`,
  });
  try {
    const scan = await vendor.scanLifetimePnl({
      onProgress: (event) => {
        if (event.kind === "trades-page") {
          emit({
            kind: "info",
            atMs: Date.now(),
            message: `lifetime pnl scan: ${event.tradesSoFar} trades fetched`,
          });
        } else {
          emit({
            kind: "info",
            atMs: Date.now(),
            message: `lifetime pnl scan: ${event.resolved}/${event.total} markets resolved`,
          });
        }
      },
    });
    lifetimePnl.value = scan.lifetimePnlUsd;
    emit({
      kind: "info",
      atMs: Date.now(),
      message: `lifetime pnl scanned: $${scan.lifetimePnlUsd.toFixed(2)} across ${scan.resolvedMarketsCounted} resolved markets (${scan.unresolvedMarketsSkipped} skipped, ${scan.tradesCounted} trades counted)`,
    });
    try {
      await persistLifetimePnl({
        walletAddress: vendor.walletAddress,
        lifetimePnlUsd: lifetimePnl.value,
      });
    } catch (error) {
      emit({
        kind: "warn",
        atMs: Date.now(),
        message: `lifetime pnl persist after scan failed: ${(error as Error).message}`,
      });
    }
  } catch (error) {
    emit({
      kind: "error",
      atMs: Date.now(),
      message: `lifetime pnl scan failed: ${(error as Error).message}; starting from $0.00`,
    });
  }
}
