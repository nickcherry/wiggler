import type { ExchangeId, QuoteTick } from "@wiggler/types/exchanges";

type Level2Update = {
  side?: string;
  price_level?: string;
  new_quantity?: string;
};

type Level2Event = {
  type?: string;
  product_id?: string;
  updates?: ReadonlyArray<Level2Update>;
};

type Level2Frame = {
  channel?: string;
  timestamp?: string;
  events?: ReadonlyArray<Level2Event>;
};

/**
 * Mutable per-stream state. Holds the full bid/ask depth so the top of
 * book can be recomputed when a level is consumed, plus cached top
 * pointers so most updates can detect a top change in O(1).
 */
export type CoinbaseLevel2State = {
  readonly bids: Map<number, number>;
  readonly asks: Map<number, number>;
  bestBid: number | null;
  bestAsk: number | null;
};

export function createCoinbaseLevel2State(): CoinbaseLevel2State {
  return {
    bids: new Map(),
    asks: new Map(),
    bestBid: null,
    bestAsk: null,
  };
}

/**
 * Applies one Coinbase Advanced Trade `level2` frame to `state`. Snapshots
 * and incremental updates use the same shape; we treat both identically.
 *
 * Returns a `QuoteTick` only when the best bid or best ask actually moved
 * — that's the signal callers care about. Pure level changes deeper in
 * the book are silently absorbed.
 */
export function applyCoinbaseLevel2Frame({
  raw,
  productId,
  exchange,
  state,
}: {
  readonly raw: string;
  readonly productId: string;
  readonly exchange: ExchangeId;
  readonly state: CoinbaseLevel2State;
}): QuoteTick | null {
  const frame = JSON.parse(raw) as Level2Frame;
  if (frame.channel !== "l2_data") {
    return null;
  }
  let topChanged = false;
  for (const ev of frame.events ?? []) {
    if (ev.product_id !== productId) {
      continue;
    }
    for (const update of ev.updates ?? []) {
      const price = Number(update.price_level);
      const qty = Number(update.new_quantity);
      const side = update.side;
      if (!Number.isFinite(price)) {
        continue;
      }
      const isBid = side === "bid";
      const isAsk = side === "offer" || side === "ask";
      if (!isBid && !isAsk) {
        continue;
      }
      const book = isBid ? state.bids : state.asks;
      const removed = !Number.isFinite(qty) || qty <= 0;
      if (removed) {
        if (!book.has(price)) {
          continue;
        }
        book.delete(price);
        if (isBid && state.bestBid === price) {
          state.bestBid = findBest({ book: state.bids, side: "bid" });
          topChanged = true;
        } else if (isAsk && state.bestAsk === price) {
          state.bestAsk = findBest({ book: state.asks, side: "ask" });
          topChanged = true;
        }
      } else {
        const previousQty = book.get(price);
        book.set(price, qty);
        if (isBid) {
          if (state.bestBid === null || price > state.bestBid) {
            state.bestBid = price;
            topChanged = true;
          } else if (price === state.bestBid && previousQty !== qty) {
            // Same-price qty change at the BBO — match Binance bookTicker's
            // "fire on price OR quantity change at top" semantics.
            topChanged = true;
          }
        } else if (isAsk) {
          if (state.bestAsk === null || price < state.bestAsk) {
            state.bestAsk = price;
            topChanged = true;
          } else if (price === state.bestAsk && previousQty !== qty) {
            topChanged = true;
          }
        }
      }
    }
  }
  if (!topChanged || state.bestBid === null || state.bestAsk === null) {
    return null;
  }
  return {
    exchange,
    tsReceivedMs: Date.now(),
    tsExchangeMs: frame.timestamp ? Date.parse(frame.timestamp) : null,
    bid: state.bestBid,
    ask: state.bestAsk,
    mid: (state.bestBid + state.bestAsk) / 2,
  };
}

function findBest({
  book,
  side,
}: {
  readonly book: ReadonlyMap<number, number>;
  readonly side: "bid" | "ask";
}): number | null {
  let best: number | null = null;
  for (const price of book.keys()) {
    if (best === null) {
      best = price;
      continue;
    }
    if (side === "bid" ? price > best : price < best) {
      best = price;
    }
  }
  return best;
}
