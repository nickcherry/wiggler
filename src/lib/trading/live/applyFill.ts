import type {
  AssetWindowRecord,
  LiveEvent,
} from "@alea/lib/trading/live/types";
import type { AssetSlot } from "@alea/lib/trading/state/types";
import { computePolymarketFeeUsd } from "@alea/lib/trading/vendor/polymarket/computePolymarketFeeUsd";
import type { Asset } from "@alea/types/assets";

/**
 * Vendor-agnostic fill update. Called by the runner when the user
 * stream emits a `FillEvent` matching one of our active slots.
 *
 * Accumulates into the slot's running totals (shares, cost, share-
 * weighted fee rate) and flips `orderId` to `null` once the cumulative
 * shares reach the order's original size — i.e. the order is fully
 * filled and there's nothing left to cancel at wrap-up.
 */
export function applyFill({
  asset,
  record,
  fill,
  emit,
}: {
  readonly asset: Asset;
  readonly record: AssetWindowRecord;
  readonly fill: {
    readonly outcomeRef: string;
    readonly price: number;
    readonly size: number;
    readonly feeRateBps: number;
  };
  readonly emit: (event: LiveEvent) => void;
}): void {
  if (record.slot.kind !== "active") {
    return;
  }
  if (record.slot.outcomeRef !== fill.outcomeRef) {
    return;
  }
  const newShares = record.slot.sharesFilled + fill.size;
  if (newShares <= 0) {
    return;
  }
  const newCost = record.slot.costUsd + fill.size * fill.price;
  const fillFeeUsd = computePolymarketFeeUsd({
    size: fill.size,
    price: fill.price,
    feeRateBps: fill.feeRateBps,
  });
  const newFeesUsd = record.slot.feesUsd + fillFeeUsd;
  const weightedFee =
    (record.slot.feeRateBpsAvg * record.slot.sharesFilled +
      fill.feeRateBps * fill.size) /
    newShares;
  // Compare against the venue-accepted `sharesIfFilled` (rounded down
  // to the venue quantum at place time), not a fresh stake/price
  // divide — they disagree slightly when the placed shares hit the
  // round-down floor.
  const fullyFilled = newShares + 1e-6 >= record.slot.sharesIfFilled;
  const updated: Extract<AssetSlot, { kind: "active" }> = {
    kind: "active",
    market: record.slot.market,
    side: record.slot.side,
    outcomeRef: record.slot.outcomeRef,
    orderId: fullyFilled ? null : record.slot.orderId,
    limitPrice: record.slot.limitPrice,
    sharesIfFilled: record.slot.sharesIfFilled,
    sharesFilled: newShares,
    costUsd: newCost,
    feesUsd: newFeesUsd,
    feeRateBpsAvg: weightedFee,
  };
  record.slot = updated;
  emit({ kind: "fill", atMs: Date.now(), asset, slot: updated });
}
