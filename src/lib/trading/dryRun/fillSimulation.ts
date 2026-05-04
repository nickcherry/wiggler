import type { MarketDataTradeEvent } from "@alea/lib/trading/vendor/types";
import type { Asset } from "@alea/types/assets";

const PRICE_EPSILON = 1e-9;

export type SimulatedDryOrder = {
  id: string;
  asset: Asset;
  windowStartMs: number;
  windowEndMs: number;
  vendorRef: string;
  outcomeRef: string;
  side: "up" | "down";
  limitPrice: number;
  sharesIfFilled: number;
  placedAtMs: number;
  expiresAtMs: number;
  queueAheadShares: number | null;
  observedAtLimitShares: number;
  canonicalFilledShares: number;
  canonicalCostUsd: number;
  canonicalFirstFillAtMs: number | null;
  canonicalFullFillAtMs: number | null;
  touchFilledAtMs: number | null;
};

export type CreateSimulatedDryOrderInput = Omit<
  SimulatedDryOrder,
  | "observedAtLimitShares"
  | "canonicalFilledShares"
  | "canonicalCostUsd"
  | "canonicalFirstFillAtMs"
  | "canonicalFullFillAtMs"
  | "touchFilledAtMs"
>;

export function createSimulatedDryOrder(
  input: CreateSimulatedDryOrderInput,
): SimulatedDryOrder {
  return {
    ...input,
    observedAtLimitShares: 0,
    canonicalFilledShares: 0,
    canonicalCostUsd: 0,
    canonicalFirstFillAtMs: null,
    canonicalFullFillAtMs: null,
    touchFilledAtMs: null,
  };
}

export function applyTradeToSimulatedOrder({
  order,
  trade,
}: {
  readonly order: SimulatedDryOrder;
  readonly trade: MarketDataTradeEvent;
}): boolean {
  if (
    trade.outcomeRef !== order.outcomeRef ||
    trade.atMs < order.placedAtMs ||
    trade.atMs > order.expiresAtMs
  ) {
    return false;
  }
  let changed = false;
  if (
    order.touchFilledAtMs === null &&
    trade.price <= order.limitPrice + PRICE_EPSILON
  ) {
    order.touchFilledAtMs = trade.atMs;
    changed = true;
  }

  if (order.canonicalFilledShares + PRICE_EPSILON >= order.sharesIfFilled) {
    return changed;
  }
  if (trade.price < order.limitPrice - PRICE_EPSILON) {
    fillCanonical({
      order,
      shares: order.sharesIfFilled - order.canonicalFilledShares,
      atMs: trade.atMs,
    });
    return true;
  }
  if (Math.abs(trade.price - order.limitPrice) > PRICE_EPSILON) {
    return changed;
  }
  if (order.queueAheadShares === null || trade.size === null || trade.size <= 0) {
    return changed;
  }

  order.observedAtLimitShares += trade.size;
  const fillableThroughQueue = Math.min(
    order.sharesIfFilled,
    Math.max(0, order.observedAtLimitShares - order.queueAheadShares),
  );
  const delta = fillableThroughQueue - order.canonicalFilledShares;
  if (delta > PRICE_EPSILON) {
    fillCanonical({ order, shares: delta, atMs: trade.atMs });
    return true;
  }
  return changed;
}

export function canonicalFillLatencyMs({
  order,
}: {
  readonly order: SimulatedDryOrder;
}): number | null {
  if (order.canonicalFirstFillAtMs === null) {
    return null;
  }
  return order.canonicalFirstFillAtMs - order.placedAtMs;
}

export function touchFillLatencyMs({
  order,
}: {
  readonly order: SimulatedDryOrder;
}): number | null {
  if (order.touchFilledAtMs === null) {
    return null;
  }
  return order.touchFilledAtMs - order.placedAtMs;
}

function fillCanonical({
  order,
  shares,
  atMs,
}: {
  readonly order: SimulatedDryOrder;
  readonly shares: number;
  readonly atMs: number;
}): void {
  const bounded = Math.min(shares, order.sharesIfFilled - order.canonicalFilledShares);
  if (bounded <= PRICE_EPSILON) {
    return;
  }
  order.canonicalFilledShares += bounded;
  order.canonicalCostUsd += bounded * order.limitPrice;
  if (order.canonicalFirstFillAtMs === null) {
    order.canonicalFirstFillAtMs = atMs;
  }
  if (order.canonicalFilledShares + PRICE_EPSILON >= order.sharesIfFilled) {
    order.canonicalFilledShares = order.sharesIfFilled;
    order.canonicalFullFillAtMs = atMs;
  }
}
