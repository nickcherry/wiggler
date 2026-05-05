import type { Asset } from "@alea/types/assets";
import type { ExchangeId, QuoteTick } from "@alea/types/exchanges";

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
 * Mutable per-product state. Holds the full bid/ask depth so the top
 * of book can be recomputed when a level is consumed, plus cached top
 * pointers so most updates can detect a top change in O(1).
 */
export type CoinbaseLevel2ProductState = {
  readonly bids: Map<number, number>;
  readonly asks: Map<number, number>;
  bestBid: number | null;
  bestAsk: number | null;
};

/**
 * Per-stream state — one product (asset) → one book. Keys are
 * Coinbase `product_id` strings (e.g. `"BTC-USD"`, `"ETH-PERP-INTX"`).
 */
export type CoinbaseLevel2State = {
  readonly byProductId: Map<string, CoinbaseLevel2ProductState>;
  readonly productIdToAsset: ReadonlyMap<string, Asset>;
};

export function createCoinbaseLevel2State({
  productIdToAsset,
}: {
  readonly productIdToAsset: ReadonlyMap<string, Asset>;
}): CoinbaseLevel2State {
  const byProductId = new Map<string, CoinbaseLevel2ProductState>();
  for (const productId of productIdToAsset.keys()) {
    byProductId.set(productId, createProductState());
  }
  return { byProductId, productIdToAsset };
}

function createProductState(): CoinbaseLevel2ProductState {
  return {
    bids: new Map(),
    asks: new Map(),
    bestBid: null,
    bestAsk: null,
  };
}

/**
 * Applies one Coinbase Advanced Trade `level2` frame to `state`.
 * Snapshots and incremental updates use the same shape; we treat
 * both identically.
 *
 * Returns one `QuoteTick` per *product whose top of book actually
 * moved* in this frame. A frame can carry events for multiple
 * products at once on the L2 channel, so we emit a tick per affected
 * product (in event order). Pure deeper-book updates are silently
 * absorbed.
 *
 * `exchange` is the venue label that goes on every emitted tick
 * (`"coinbase-spot"` or `"coinbase-perp"`).
 */
export function applyCoinbaseLevel2Frame({
  raw,
  exchange,
  state,
}: {
  readonly raw: string;
  readonly exchange: ExchangeId;
  readonly state: CoinbaseLevel2State;
}): readonly QuoteTick[] {
  const frame = JSON.parse(raw) as Level2Frame;
  if (frame.channel !== "l2_data") {
    return [];
  }
  const out: QuoteTick[] = [];
  const tsExchangeMs = frame.timestamp ? Date.parse(frame.timestamp) : null;
  for (const ev of frame.events ?? []) {
    if (ev.product_id === undefined) {
      continue;
    }
    const product = state.byProductId.get(ev.product_id);
    const asset = state.productIdToAsset.get(ev.product_id);
    if (product === undefined || asset === undefined) {
      continue;
    }
    let topChanged = false;
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
      const book = isBid ? product.bids : product.asks;
      const removed = !Number.isFinite(qty) || qty <= 0;
      if (removed) {
        if (!book.has(price)) {
          continue;
        }
        book.delete(price);
        if (isBid && product.bestBid === price) {
          product.bestBid = findBest({ book: product.bids, side: "bid" });
          topChanged = true;
        } else if (isAsk && product.bestAsk === price) {
          product.bestAsk = findBest({ book: product.asks, side: "ask" });
          topChanged = true;
        }
      } else {
        const previousQty = book.get(price);
        book.set(price, qty);
        if (isBid) {
          if (product.bestBid === null || price > product.bestBid) {
            product.bestBid = price;
            topChanged = true;
          } else if (price === product.bestBid && previousQty !== qty) {
            // Same-price qty change at the BBO — match Binance bookTicker's
            // "fire on price OR quantity change at top" semantics.
            topChanged = true;
          }
        } else if (isAsk) {
          if (product.bestAsk === null || price < product.bestAsk) {
            product.bestAsk = price;
            topChanged = true;
          } else if (price === product.bestAsk && previousQty !== qty) {
            topChanged = true;
          }
        }
      }
    }
    if (
      topChanged &&
      product.bestBid !== null &&
      product.bestAsk !== null
    ) {
      out.push({
        exchange,
        asset,
        tsReceivedMs: Date.now(),
        tsExchangeMs,
        bid: product.bestBid,
        ask: product.bestAsk,
        mid: (product.bestBid + product.bestAsk) / 2,
      });
    }
  }
  return out;
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
