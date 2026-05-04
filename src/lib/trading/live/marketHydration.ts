import { EMA50_BOOTSTRAP_BARS } from "@alea/constants/trading";
import type { FiveMinuteAtrTracker } from "@alea/lib/livePrices/fiveMinuteAtrTracker";
import type { FiveMinuteEmaTracker } from "@alea/lib/livePrices/fiveMinuteEmaTracker";
import type { LivePriceSource } from "@alea/lib/livePrices/source";
import { activeSlotFromHydration } from "@alea/lib/trading/live/slotHydration";
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
 * Bootstrap each asset's moving trackers (EMA-50 and the live ATR)
 * with the most recent closed 5m bars from the price-feed REST
 * endpoint. EMA needs ≥50 closes; ATR needs ≥`LIVE_TRADING_ATR_PERIOD`.
 * We pull `EMA50_BOOTSTRAP_BARS` (60 by default) which seeds both with
 * margin to spare, and fetch
 * once per asset so the two trackers share a single network round-
 * trip. Failures are logged and the runner proceeds — decisions
 * just stay in the `warmup` skip state until the live stream catches
 * up.
 */
export async function hydrateMovingTrackers({
  assets,
  emas,
  atrs,
  signal,
  emit,
  priceSource,
}: {
  readonly assets: readonly Asset[];
  readonly emas: Map<Asset, FiveMinuteEmaTracker>;
  readonly atrs: Map<Asset, FiveMinuteAtrTracker>;
  readonly signal: AbortSignal;
  readonly emit: (event: LiveEvent) => void;
  readonly priceSource: LivePriceSource;
}): Promise<void> {
  for (const asset of assets) {
    if (signal.aborted) {
      return;
    }
    try {
      const bars = await priceSource.fetchRecentFiveMinuteBars({
        asset,
        count: EMA50_BOOTSTRAP_BARS,
        signal,
      });
      const ema = emas.get(asset);
      const atr = atrs.get(asset);
      for (const bar of bars) {
        ema?.append(bar);
        atr?.append(bar);
      }
      const emaValue = ema?.currentValue();
      const atrValue = atr?.currentValue();
      emit({
        kind: "info",
        atMs: Date.now(),
        message: `${labelAsset(asset)} hydrated ${bars.length} closed 5m bars, ema50=${emaValue === null || emaValue === undefined ? "warming" : emaValue.toFixed(2)}, atr=${atrValue === null || atrValue === undefined ? "warming" : atrValue.toFixed(2)}`,
      });
    } catch (error) {
      emit({
        kind: "warn",
        atMs: Date.now(),
        message: `${labelAsset(asset)} tracker bootstrap failed: ${(error as Error).message}`,
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
    record.hydrationStatus = "failed";
    emit({
      kind: "error",
      atMs: Date.now(),
      message: `${labelAsset(asset)} market discovery failed: ${(error as Error).message}`,
    });
    return;
  }
  if (market === null) {
    record.hydrationStatus = "failed";
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
    record.hydrationStatus = "ready";
    const slot = activeSlotFromHydration({ market, hydration });
    if (slot !== null) {
      record.slot = slot;
      emit({
        kind: "info",
        atMs: Date.now(),
        message: `${labelAsset(asset)} hydrated leftover state: side=${slot.side} order=${slot.orderId ?? "none"} filled=${hydration.sharesFilled}`,
      });
    }
  } catch (error) {
    record.hydrationStatus = "failed";
    emit({
      kind: "warn",
      atMs: Date.now(),
      message: `${labelAsset(asset)} state hydration failed (trading disabled for this market): ${(error as Error).message}`,
    });
    return;
  }

  emit({
    kind: "info",
    atMs: Date.now(),
    message: `${labelAsset(asset)} discovered ${market.displayLabel ?? market.vendorRef}, accepting=${market.acceptingOrders}`,
  });
}
