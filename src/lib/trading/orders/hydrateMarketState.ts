import type { PlacedOrder } from "@alea/lib/trading/orders/types";
import type { LeadingSide } from "@alea/lib/trading/types";
import type { ClobClient, OpenOrder, Trade } from "@polymarket/clob-client";

/**
 * Aggregate fill state reconstructed from a market's fill history. The
 * runner uses this to detect that we already have a (partially-)filled
 * position when it boots mid-window.
 *
 * `sharesFilled` is in YES-token units, `costUsd` is the realized USDC
 * cost across the maker fills (sum of `shares × price` per fill).
 */
export type MarketFillState = {
  readonly side: LeadingSide;
  readonly tokenId: string;
  readonly sharesFilled: number;
  readonly costUsd: number;
  readonly feeRateBps: number;
};

/**
 * Per-market hydration result: the resting limit order (if any) and
 * the realized fill state (if any). Both fields are independently
 * `null`; a bot that crashed mid-window may have either, neither, or
 * both — though in steady-state operation we expect "either".
 */
export type MarketHydration = {
  readonly openOrder: PlacedOrder | null;
  readonly fillState: MarketFillState | null;
};

/**
 * Reads the current state of a single up/down market from Polymarket
 * — open orders + our recent fills — and rolls them into the slim
 * shape the runner stores in memory. This is the chunk-2 answer to
 * "Polymarket is the source of truth: hydrate from it on boot."
 *
 * Filters by both conditionId and our wallet address: the SDK's
 * `getOpenOrders({ market })` parameter takes a conditionId, and
 * `getTrades({ market })` returns only our trades.
 */
export async function hydrateMarketState({
  client,
  conditionId,
  upTokenId,
  downTokenId,
}: {
  readonly client: ClobClient;
  readonly conditionId: string;
  readonly upTokenId: string;
  readonly downTokenId: string;
}): Promise<MarketHydration> {
  const [openOrders, trades] = await Promise.all([
    client.getOpenOrders({ market: conditionId }),
    client.getTrades({ market: conditionId }),
  ]);

  const openOrder = pickOpenOrder({
    openOrders,
    upTokenId,
    downTokenId,
  });
  const fillState = aggregateFills({ trades, upTokenId, downTokenId });
  return { openOrder, fillState };
}

function pickOpenOrder({
  openOrders,
  upTokenId,
  downTokenId,
}: {
  readonly openOrders: readonly OpenOrder[];
  readonly upTokenId: string;
  readonly downTokenId: string;
}): PlacedOrder | null {
  // Prefer the most recently created order if (somehow) there are
  // multiple resting on the same market — a clean live runner enforces
  // one-per-asset, but a leftover from a previous misbehaving process
  // shouldn't crash hydration.
  const sorted = [...openOrders].sort(
    (a, b) => Number(b.created_at) - Number(a.created_at),
  );
  for (const order of sorted) {
    if (order.side !== "BUY") {
      continue;
    }
    const side = sideOf({
      tokenId: order.asset_id,
      upTokenId,
      downTokenId,
    });
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
      tokenId: order.asset_id,
      limitPrice,
      stakeUsd: originalSize * limitPrice,
      sharesIfFilled: originalSize,
      // The OpenOrder shape doesn't surface the order's fee rate, so we
      // settle for 0 here — used only by the runner for log formatting,
      // and the actual fill events carry the real rate.
      feeRateBps: 0,
      placedAtMs:
        typeof order.created_at === "number"
          ? order.created_at * 1000
          : Date.now(),
    };
  }
  return null;
}

function aggregateFills({
  trades,
  upTokenId,
  downTokenId,
}: {
  readonly trades: readonly Trade[];
  readonly upTokenId: string;
  readonly downTokenId: string;
}): MarketFillState | null {
  let totalShares = 0;
  let totalCost = 0;
  let observedSide: LeadingSide | null = null;
  let observedTokenId: string | null = null;
  let weightedFeeBpsNumerator = 0;
  for (const trade of trades) {
    const side = sideOf({
      tokenId: trade.asset_id,
      upTokenId,
      downTokenId,
    });
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
    weightedFeeBpsNumerator += shares * Number(trade.fee_rate_bps);
    observedSide = side;
    observedTokenId = trade.asset_id;
  }
  if (observedSide === null || observedTokenId === null || totalShares === 0) {
    return null;
  }
  return {
    side: observedSide,
    tokenId: observedTokenId,
    sharesFilled: totalShares,
    costUsd: totalCost,
    feeRateBps: weightedFeeBpsNumerator / totalShares,
  };
}

function sideOf({
  tokenId,
  upTokenId,
  downTokenId,
}: {
  readonly tokenId: string;
  readonly upTokenId: string;
  readonly downTokenId: string;
}): LeadingSide | null {
  if (tokenId === upTokenId) {
    return "up";
  }
  if (tokenId === downTokenId) {
    return "down";
  }
  return null;
}
