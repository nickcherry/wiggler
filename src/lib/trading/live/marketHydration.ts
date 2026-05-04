import { EMA50_BOOTSTRAP_BARS } from "@alea/constants/trading";
import { fetchRecentFiveMinuteBars } from "@alea/lib/livePrices/binancePerp/fetchRecentFiveMinuteBars";
import type { FiveMinuteEmaTracker } from "@alea/lib/livePrices/fiveMinuteEmaTracker";
import type {
  AssetWindowRecord,
  ConditionIndex,
  LiveEvent,
  WindowRecord,
} from "@alea/lib/trading/live/types";
import { labelAsset } from "@alea/lib/trading/live/utils";
import type { Vendor } from "@alea/lib/trading/vendor/types";
import type { Asset } from "@alea/types/assets";

/**
 * Bootstrap each asset's EMA-50 tracker with the most recent closed
 * 5m bars from the price-feed REST endpoint. The tracker needs ≥50
 * closes before it returns a non-null EMA; we pull `EMA50_BOOTSTRAP_BARS`
 * (60 by default) so an occasional missed bar over the wire doesn't
 * stall the seed. Failures are logged and the runner proceeds —
 * decisions just stay in the `warmup` skip state until the live
 * stream catches up.
 */
export async function hydrateEmas({
  assets,
  emas,
  signal,
  emit,
}: {
  readonly assets: readonly Asset[];
  readonly emas: Map<Asset, FiveMinuteEmaTracker>;
  readonly signal: AbortSignal;
  readonly emit: (event: LiveEvent) => void;
}): Promise<void> {
  for (const asset of assets) {
    if (signal.aborted) {
      return;
    }
    try {
      const bars = await fetchRecentFiveMinuteBars({
        asset,
        count: EMA50_BOOTSTRAP_BARS,
        signal,
      });
      const tracker = emas.get(asset);
      if (tracker !== undefined) {
        for (const bar of bars) {
          tracker.append(bar);
        }
      }
      const ema = tracker?.currentValue();
      emit({
        kind: "info",
        atMs: Date.now(),
        message: `${labelAsset(asset)} hydrated ${bars.length} closed 5m bars, ema50=${ema === null || ema === undefined ? "warming" : ema.toFixed(2)}`,
      });
    } catch (error) {
      emit({
        kind: "warn",
        atMs: Date.now(),
        message: `${labelAsset(asset)} ema bootstrap failed: ${(error as Error).message}`,
      });
    }
  }
}

/**
 * Per-asset market discovery + state hydration:
 *
 *   1. Look up the venue's market for the asset's current 5m window.
 *      Missing markets (slug not yet created) are an info-level skip.
 *   2. Refresh the user-WS subscription so it covers the new
 *      conditionId.
 *   3. Pull `getOpenOrders` + `getTrades` for that market and seed
 *      the asset's slot if either returns anything — this is how a
 *      restarted bot picks up an open order or partial fill that the
 *      previous process left running.
 *
 * Async; returns when all three steps complete (or fail). Errors are
 * logged but never thrown — the runner continues without that asset
 * for the window.
 */
export async function hydrateAssetMarket({
  asset,
  record,
  window,
  vendor,
  conditionIdIndex,
  onSubscribe,
  signal,
  emit,
}: {
  readonly asset: Asset;
  readonly record: AssetWindowRecord;
  readonly window: WindowRecord;
  readonly vendor: Vendor;
  readonly conditionIdIndex: ConditionIndex;
  readonly onSubscribe: () => void;
  readonly signal: AbortSignal;
  readonly emit: (event: LiveEvent) => void;
}): Promise<void> {
  const windowStartUnixSeconds = Math.floor(window.windowStartMs / 1000);
  let market;
  try {
    market = await vendor.discoverMarket({
      asset,
      windowStartUnixSeconds,
      signal,
    });
  } catch (error) {
    emit({
      kind: "error",
      atMs: Date.now(),
      message: `${labelAsset(asset)} market discovery failed: ${(error as Error).message}`,
    });
    return;
  }
  if (market === null) {
    emit({
      kind: "warn",
      atMs: Date.now(),
      message: `${labelAsset(asset)} no ${vendor.id} market for window ${new Date(window.windowStartMs).toISOString().slice(11, 16)}`,
    });
    return;
  }
  record.market = market;
  conditionIdIndex.set(market.vendorRef, {
    windowStartMs: window.windowStartMs,
    asset,
  });
  onSubscribe();

  try {
    const hydration = await vendor.hydrateMarketState({ market });
    if (hydration.openOrder !== null || hydration.sharesFilled > 0) {
      const side = hydration.side;
      if (side !== null) {
        const order = hydration.openOrder;
        record.slot = {
          kind: "active",
          market,
          side,
          outcomeRef:
            hydration.outcomeRef ??
            (side === "up" ? market.upRef : market.downRef),
          orderId: order?.orderId ?? null,
          // Fallback chain for limitPrice when only fills are known:
          // average fill price (= cost / shares), then the order's
          // own limit, then 0 as a defensive last resort.
          limitPrice:
            order?.limitPrice ??
            (hydration.sharesFilled > 0
              ? hydration.costUsd / hydration.sharesFilled
              : 0),
          sharesIfFilled: order?.sharesIfFilled ?? hydration.sharesFilled,
          sharesFilled: hydration.sharesFilled,
          costUsd: hydration.costUsd,
          feeRateBpsAvg: hydration.feeRateBpsAvg,
        };
        emit({
          kind: "info",
          atMs: Date.now(),
          message: `${labelAsset(asset)} hydrated leftover state: side=${side} order=${order?.orderId ?? "none"} filled=${hydration.sharesFilled}`,
        });
      }
    }
  } catch (error) {
    emit({
      kind: "warn",
      atMs: Date.now(),
      message: `${labelAsset(asset)} state hydration failed (continuing with empty slot): ${(error as Error).message}`,
    });
  }

  emit({
    kind: "info",
    atMs: Date.now(),
    message: `${labelAsset(asset)} discovered ${market.displayLabel ?? market.vendorRef}, accepting=${market.acceptingOrders}`,
  });
}
