import type {
  StreamHandle,
  StreamQuotesParams,
} from "@alea/lib/exchangePrices/types";
import type { QuoteTick } from "@alea/types/exchanges";

const url = "wss://api.gemini.com/v2/marketdata";

/**
 * Subscribes to Gemini's v2 marketdata `l2` channel for BTCUSD and maintains
 * a small in-memory book to derive the best bid and best ask. Emits a
 * `QuoteTick` every time either edge moves.
 *
 * Subscribe: { type: "subscribe", subscriptions: [{ name: "l2", symbols:
 *               ["BTCUSD"] }] }
 * Frames: { type: "l2_updates", symbol, changes: [["buy"|"sell", price, qty]],
 *           ... } — qty "0" removes the level.
 */
export function streamGeminiSpotQuotes({
  onTick,
  onError,
  onOpen,
  onClose,
}: StreamQuotesParams): StreamHandle {
  const ws = new WebSocket(url);
  const bids = new Map<number, number>();
  const asks = new Map<number, number>();
  let lastBid: number | null = null;
  let lastAsk: number | null = null;

  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        type: "subscribe",
        subscriptions: [{ name: "l2", symbols: ["BTCUSD"] }],
      }),
    );
    onOpen?.();
  });
  ws.addEventListener("close", () => onClose?.());
  ws.addEventListener("error", () =>
    onError(new Error("gemini-spot websocket error")),
  );
  ws.addEventListener("message", (event: MessageEvent<string>) => {
    try {
      const tick = applyFrame({
        raw: event.data,
        bids,
        asks,
        lastBid,
        lastAsk,
      });
      if (tick) {
        lastBid = tick.bid;
        lastAsk = tick.ask;
        onTick(tick);
      }
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  });

  return {
    stop: async () => {
      ws.close();
    },
  };
}

type GeminiL2Frame = {
  type?: string;
  symbol?: string;
  changes?: ReadonlyArray<readonly [string, string, string]>;
};

function applyFrame({
  raw,
  bids,
  asks,
  lastBid,
  lastAsk,
}: {
  readonly raw: string;
  readonly bids: Map<number, number>;
  readonly asks: Map<number, number>;
  readonly lastBid: number | null;
  readonly lastAsk: number | null;
}): QuoteTick | null {
  const data = JSON.parse(raw) as GeminiL2Frame;
  if (data.type !== "l2_updates" || data.symbol !== "BTCUSD") {
    return null;
  }
  for (const change of data.changes ?? []) {
    const side = change[0];
    const price = Number(change[1]);
    const qty = Number(change[2]);
    if (!Number.isFinite(price) || !Number.isFinite(qty)) {
      continue;
    }
    const book = side === "buy" ? bids : side === "sell" ? asks : null;
    if (!book) {
      continue;
    }
    if (qty === 0) {
      book.delete(price);
    } else {
      book.set(price, qty);
    }
  }

  const bestBid = topOfBook({ book: bids, kind: "buy" });
  const bestAsk = topOfBook({ book: asks, kind: "sell" });
  if (bestBid === null || bestAsk === null) {
    return null;
  }
  if (bestBid === lastBid && bestAsk === lastAsk) {
    return null;
  }

  return {
    exchange: "gemini-spot",
    tsReceivedMs: Date.now(),
    tsExchangeMs: null,
    bid: bestBid,
    ask: bestAsk,
    mid: (bestBid + bestAsk) / 2,
  };
}

function topOfBook({
  book,
  kind,
}: {
  readonly book: ReadonlyMap<number, number>;
  readonly kind: "buy" | "sell";
}): number | null {
  if (book.size === 0) {
    return null;
  }
  let best: number | null = null;
  for (const price of book.keys()) {
    if (best === null) {
      best = price;
      continue;
    }
    if (kind === "buy" ? price > best : price < best) {
      best = price;
    }
  }
  return best;
}
