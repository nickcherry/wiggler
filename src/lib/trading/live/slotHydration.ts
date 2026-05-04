import type { AssetSlot } from "@alea/lib/trading/state/types";
import type {
  MarketHydration,
  TradableMarket,
} from "@alea/lib/trading/vendor/types";

export function activeSlotFromHydration({
  market,
  hydration,
}: {
  readonly market: TradableMarket;
  readonly hydration: MarketHydration;
}): Extract<AssetSlot, { kind: "active" }> | null {
  if (hydration.openOrder === null && hydration.sharesFilled <= 0) {
    return null;
  }
  const side = hydration.side;
  if (side === null) {
    return null;
  }
  const order = hydration.openOrder;
  return {
    kind: "active",
    market,
    side,
    outcomeRef:
      hydration.outcomeRef ?? (side === "up" ? market.upRef : market.downRef),
    orderId: order?.orderId ?? null,
    limitPrice:
      order?.limitPrice ??
      (hydration.sharesFilled > 0
        ? hydration.costUsd / hydration.sharesFilled
        : 0),
    sharesIfFilled: order?.sharesIfFilled ?? hydration.sharesFilled,
    sharesFilled: hydration.sharesFilled,
    costUsd: hydration.costUsd,
    feesUsd: hydration.feesUsd,
    feeRateBpsAvg: hydration.feeRateBpsAvg,
  };
}
