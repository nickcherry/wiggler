import { coinbasePerpProductId } from "@alea/lib/candles/sources/coinbase/coinbasePerpProductId";
import { coinbaseProductId } from "@alea/lib/candles/sources/coinbase/coinbaseProductId";
import { createReconnectingWebSocket } from "@alea/lib/reliability/feeds/createReconnectingWebSocket";
import type {
  ReliabilityFeedCallbacks,
  ReliabilityFeedHandle,
} from "@alea/lib/reliability/feeds/types";
import type {
  ReliabilityPriceTick,
  ReliabilitySource,
} from "@alea/lib/reliability/types";
import type { Asset } from "@alea/types/assets";
import { z } from "zod";

const COINBASE_WS_URL = "wss://advanced-trade-ws.coinbase.com";

export type CoinbaseProductState = {
  readonly asset: Asset;
  readonly productId: string;
  readonly bids: Map<number, number>;
  readonly asks: Map<number, number>;
  bestBid: number | null;
  bestAsk: number | null;
};

export function streamCoinbaseSpotReliabilityPrices({
  assets,
  onTick,
  onOpen,
  onClose,
  onError,
}: ReliabilityFeedCallbacks): ReliabilityFeedHandle {
  return streamCoinbaseReliabilityPrices({
    source: "coinbase-spot",
    productStates: createCoinbaseProductStates({
      assets,
      productIdForAsset: coinbaseProductId,
    }),
    onTick,
    onOpen,
    onClose,
    onError,
  });
}

export function streamCoinbasePerpReliabilityPrices({
  assets,
  onTick,
  onOpen,
  onClose,
  onError,
}: ReliabilityFeedCallbacks): ReliabilityFeedHandle {
  return streamCoinbaseReliabilityPrices({
    source: "coinbase-perp",
    productStates: createCoinbaseProductStates({
      assets,
      productIdForAsset: coinbasePerpProductId,
    }),
    onTick,
    onOpen,
    onClose,
    onError,
  });
}

export function createCoinbaseProductStates({
  assets,
  productIdForAsset,
}: {
  readonly assets: readonly Asset[];
  readonly productIdForAsset: (input: { readonly asset: Asset }) => string;
}): Map<string, CoinbaseProductState> {
  const states = new Map<string, CoinbaseProductState>();
  for (const asset of assets) {
    const productId = productIdForAsset({ asset });
    states.set(productId, {
      asset,
      productId,
      bids: new Map(),
      asks: new Map(),
      bestBid: null,
      bestAsk: null,
    });
  }
  return states;
}

export function parseCoinbaseLevel2Frame({
  raw,
  source,
  productStates,
  receivedAtMs,
}: {
  readonly raw: string;
  readonly source: Extract<
    ReliabilitySource,
    "coinbase-spot" | "coinbase-perp"
  >;
  readonly productStates: Map<string, CoinbaseProductState>;
  readonly receivedAtMs: number;
}): readonly ReliabilityPriceTick[] {
  const parsed = coinbaseLevel2FrameSchema.safeParse(JSON.parse(raw));
  if (!parsed.success || parsed.data.channel !== "l2_data") {
    return [];
  }

  const exchangeTimeMs =
    parsed.data.timestamp === undefined
      ? null
      : Date.parse(parsed.data.timestamp);
  const ticks: ReliabilityPriceTick[] = [];
  for (const event of parsed.data.events ?? []) {
    const state =
      event.product_id === undefined
        ? undefined
        : productStates.get(event.product_id);
    if (state === undefined) {
      continue;
    }
    if (applyCoinbaseUpdates({ state, updates: event.updates ?? [] })) {
      if (state.bestBid !== null && state.bestAsk !== null) {
        ticks.push({
          source,
          asset: state.asset,
          price: (state.bestBid + state.bestAsk) / 2,
          receivedAtMs,
          exchangeTimeMs: Number.isFinite(exchangeTimeMs)
            ? exchangeTimeMs
            : null,
        });
      }
    }
  }
  return ticks;
}

function streamCoinbaseReliabilityPrices({
  source,
  productStates,
  onTick,
  onOpen,
  onClose,
  onError,
}: {
  readonly source: Extract<
    ReliabilitySource,
    "coinbase-spot" | "coinbase-perp"
  >;
  readonly productStates: Map<string, CoinbaseProductState>;
} & Omit<ReliabilityFeedCallbacks, "assets">): ReliabilityFeedHandle {
  const productIds = [...productStates.keys()];
  return createReconnectingWebSocket({
    source,
    url: COINBASE_WS_URL,
    onOpen: (ws) => {
      ws.send(
        JSON.stringify({
          type: "subscribe",
          channel: "level2",
          product_ids: productIds,
        }),
      );
    },
    onConnect: () => onOpen?.(source),
    onDisconnect: (reason) => onClose?.(source, reason),
    onError: (error) => onError?.(source, error),
    onMessage: (raw) => {
      const ticks = parseCoinbaseLevel2Frame({
        raw,
        source,
        productStates,
        receivedAtMs: Date.now(),
      });
      for (const tick of ticks) {
        onTick(tick);
      }
    },
  });
}

function applyCoinbaseUpdates({
  state,
  updates,
}: {
  readonly state: CoinbaseProductState;
  readonly updates: readonly CoinbaseLevel2Update[];
}): boolean {
  let topChanged = false;
  for (const update of updates) {
    const price = Number(update.price_level);
    const qty = Number(update.new_quantity);
    if (!Number.isFinite(price)) {
      continue;
    }
    const isBid = update.side === "bid";
    const isAsk = update.side === "offer" || update.side === "ask";
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
      continue;
    }

    const previousQty = book.get(price);
    book.set(price, qty);
    if (isBid) {
      if (state.bestBid === null || price > state.bestBid) {
        state.bestBid = price;
        topChanged = true;
      } else if (price === state.bestBid && previousQty !== qty) {
        topChanged = true;
      }
    } else if (state.bestAsk === null || price < state.bestAsk) {
      state.bestAsk = price;
      topChanged = true;
    } else if (price === state.bestAsk && previousQty !== qty) {
      topChanged = true;
    }
  }
  return topChanged;
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

const coinbaseLevel2UpdateSchema = z.object({
  side: z.string().optional(),
  price_level: z.string().optional(),
  new_quantity: z.string().optional(),
});

type CoinbaseLevel2Update = z.infer<typeof coinbaseLevel2UpdateSchema>;

const coinbaseLevel2EventSchema = z.object({
  type: z.string().optional(),
  product_id: z.string().optional(),
  updates: z.array(coinbaseLevel2UpdateSchema).optional(),
});

const coinbaseLevel2FrameSchema = z
  .object({
    channel: z.string().optional(),
    timestamp: z.string().optional(),
    events: z.array(coinbaseLevel2EventSchema).optional(),
  })
  .passthrough();
