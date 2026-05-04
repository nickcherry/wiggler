import type { LeadingSide } from "@alea/lib/trading/types";
import { computePolymarketFeeUsd } from "@alea/lib/trading/vendor/polymarket/computePolymarketFeeUsd";
import type {
  MarketHydration,
  PlacedOrder,
  TradableMarket,
} from "@alea/lib/trading/vendor/types";
import type { ClobClient, OpenOrder, Trade } from "@polymarket/clob-client";

/**
 * Polymarket implementation of `Vendor.hydrateMarketState`. The runner
 * calls this on every market discovery so a process restart picks up
 * any open order or partial fill the venue has on file for our wallet.
 *
 * Combines `getOpenOrders({ market })` and `getTrades({ market })`
 * into the shape `MarketHydration` exposes — neutral on the vendor
 * specifics. Both are issued in parallel; the wider scan takes the
 * cost of one round-trip plus payload, ~150–250ms in our region.
 */
export async function hydratePolymarketMarketState({
  client,
  market,
}: {
  readonly client: ClobClient;
  readonly market: TradableMarket;
}): Promise<MarketHydration> {
  const [openOrders, trades] = await Promise.all([
    client.getOpenOrders({ market: market.vendorRef }),
    client.getTrades({ market: market.vendorRef }),
  ]);
  const openOrder = pickOpenOrder({
    openOrders,
    upRef: market.upRef,
    downRef: market.downRef,
  });
  const fills = aggregateFills({
    trades,
    upRef: market.upRef,
    downRef: market.downRef,
  });
  return {
    openOrder,
    side: fills.side ?? openOrder?.side ?? null,
    outcomeRef: fills.outcomeRef ?? openOrder?.outcomeRef ?? null,
    sharesFilled: fills.sharesFilled,
    costUsd: fills.costUsd,
    feesUsd: fills.feesUsd,
    feeRateBpsAvg: fills.feeRateBpsAvg,
  };
}

function pickOpenOrder({
  openOrders,
  upRef,
  downRef,
}: {
  readonly openOrders: readonly OpenOrder[];
  readonly upRef: string;
  readonly downRef: string;
}): PlacedOrder | null {
  const sorted = [...openOrders].sort(
    (a, b) => Number(b.created_at) - Number(a.created_at),
  );
  for (const order of sorted) {
    if (order.side !== "BUY") {
      continue;
    }
    const side = sideOf({ tokenId: order.asset_id, upRef, downRef });
    if (side === null) {
      continue;
    }
    const limitPrice = Number(order.price);
    const originalSize = Number(order.original_size);
    if (
      !Number.isFinite(limitPrice) ||
      limitPrice <= 0 ||
      !Number.isFinite(originalSize) ||
      originalSize <= 0
    ) {
      continue;
    }
    return {
      orderId: order.id,
      side,
      outcomeRef: order.asset_id,
      limitPrice,
      sharesIfFilled: originalSize,
      feeRateBps: 0,
      placedAtMs:
        typeof order.created_at === "number"
          ? order.created_at * 1000
          : Date.now(),
    };
  }
  return null;
}

type FillAggregate = {
  readonly side: LeadingSide | null;
  readonly outcomeRef: string | null;
  readonly sharesFilled: number;
  readonly costUsd: number;
  readonly feesUsd: number;
  readonly feeRateBpsAvg: number;
};

function aggregateFills({
  trades,
  upRef,
  downRef,
}: {
  readonly trades: readonly Trade[];
  readonly upRef: string;
  readonly downRef: string;
}): FillAggregate {
  let totalShares = 0;
  let totalCost = 0;
  let totalFeesUsd = 0;
  let observedSide: LeadingSide | null = null;
  let observedTokenId: string | null = null;
  let weightedFeeBpsNumerator = 0;
  for (const trade of trades) {
    const side = sideOf({ tokenId: trade.asset_id, upRef, downRef });
    if (side === null) {
      continue;
    }
    const shares = Number(trade.size);
    const price = Number(trade.price);
    if (!Number.isFinite(shares) || !Number.isFinite(price) || shares <= 0) {
      continue;
    }
    totalShares += shares;
    totalCost += shares * price;
    const feeRateBps = Number(trade.fee_rate_bps);
    const safeFeeRateBps =
      trade.trader_side === "MAKER" || !Number.isFinite(feeRateBps)
        ? 0
        : feeRateBps;
    totalFeesUsd += computePolymarketFeeUsd({
      size: shares,
      price,
      feeRateBps: safeFeeRateBps,
    });
    weightedFeeBpsNumerator += shares * safeFeeRateBps;
    observedSide = side;
    observedTokenId = trade.asset_id;
  }
  if (totalShares === 0) {
    return {
      side: null,
      outcomeRef: null,
      sharesFilled: 0,
      costUsd: 0,
      feesUsd: 0,
      feeRateBpsAvg: 0,
    };
  }
  return {
    side: observedSide,
    outcomeRef: observedTokenId,
    sharesFilled: totalShares,
    costUsd: totalCost,
    feesUsd: totalFeesUsd,
    feeRateBpsAvg: weightedFeeBpsNumerator / totalShares,
  };
}

function sideOf({
  tokenId,
  upRef,
  downRef,
}: {
  readonly tokenId: string;
  readonly upRef: string;
  readonly downRef: string;
}): LeadingSide | null {
  if (tokenId === upRef) {
    return "up";
  }
  if (tokenId === downRef) {
    return "down";
  }
  return null;
}
