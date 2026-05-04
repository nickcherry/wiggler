import type { LifetimePnlBox, LiveEvent } from "@alea/lib/trading/live/types";
import {
  loadLifetimePnl,
  persistLifetimePnl,
} from "@alea/lib/trading/state/lifetimePnlStore";
import type { Vendor } from "@alea/lib/trading/vendor/types";

/**
 * Boot-time lifetime PnL hydration. Loads the on-disk checkpoint if
 * it matches the running wallet, then reconciles it against a vendor-
 * side trade-history scan so `Total Pnl` is venue truth, not a stale
 * proxy-settled checkpoint.
 *
 * Always returns — failures are logged but the runner proceeds with
 * whatever value the bootstrap could produce (zero if all paths
 * fail).
 */
export async function bootstrapLifetimePnl({
  vendor,
  lifetimePnl,
  lifetimePnlPath,
  emit,
}: {
  readonly vendor: Vendor;
  readonly lifetimePnl: LifetimePnlBox;
  readonly lifetimePnlPath?: string;
  readonly emit: (event: LiveEvent) => void;
}): Promise<void> {
  const loaded = await loadLifetimePnl({
    walletAddress: vendor.walletAddress,
    path: lifetimePnlPath,
  });
  if (loaded.source === "loaded") {
    lifetimePnl.value = loaded.lifetimePnlUsd;
    emit({
      kind: "info",
      atMs: Date.now(),
      message: `lifetime pnl loaded: $${loaded.lifetimePnlUsd.toFixed(2)} (as-of ${new Date(loaded.asOfMs).toISOString()})`,
    });
    emit({
      kind: "info",
      atMs: Date.now(),
      message: `lifetime pnl checkpoint loaded; reconciling ${vendor.id} trade history…`,
    });
  } else {
    emit({
      kind: "info",
      atMs: Date.now(),
      message: `lifetime pnl checkpoint ${loaded.reason}; scanning ${vendor.id} trade history…`,
    });
  }
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
      message: `lifetime pnl reconciled: $${scan.lifetimePnlUsd.toFixed(2)} across ${scan.resolvedMarketsCounted} resolved markets (${scan.unresolvedMarketsSkipped} skipped, ${scan.tradesCounted} trades counted)`,
    });
    try {
      await persistLifetimePnl({
        walletAddress: vendor.walletAddress,
        lifetimePnlUsd: lifetimePnl.value,
        path: lifetimePnlPath,
      });
    } catch (error) {
      emit({
        kind: "warn",
        atMs: Date.now(),
        message: `lifetime pnl persist after scan failed: ${(error as Error).message}`,
      });
    }
  } catch (error) {
    if (loaded.source === "loaded") {
      emit({
        kind: "warn",
        atMs: Date.now(),
        message: `lifetime pnl reconciliation failed: ${(error as Error).message}; keeping loaded checkpoint $${loaded.lifetimePnlUsd.toFixed(2)}`,
      });
      return;
    }
    emit({
      kind: "error",
      atMs: Date.now(),
      message: `lifetime pnl scan failed: ${(error as Error).message}; starting from $0.00`,
    });
  }
}
