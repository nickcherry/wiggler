import type {
  StreamHandle,
  StreamQuotesParams,
} from "@alea/lib/exchangePrices/types";
import type { QuoteTick } from "@alea/types/exchanges";

const url = "wss://ws.bitstamp.net";
const channel = "order_book_btcusd";

/**
 * Subscribes to Bitstamp's `order_book_btcusd` channel, which streams the
 * full top-of-book on every change. We take `bids[0][0]` / `asks[0][0]` as
 * the best bid/ask.
 *
 * Subscribe shape: { event: "bts:subscribe", data: { channel } }
 * Data event: { event: "data", channel, data: { bids: [[price, size]...],
 *                                                asks: [[price, size]...],
 *                                                microtimestamp: "us" } }
 */
export function streamBitstampSpotQuotes({
  onTick,
  onError,
  onOpen,
  onClose,
}: StreamQuotesParams): StreamHandle {
  const ws = new WebSocket(url);

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ event: "bts:subscribe", data: { channel } }));
    onOpen?.();
  });
  ws.addEventListener("close", () => onClose?.());
  ws.addEventListener("error", () =>
    onError(new Error("bitstamp-spot websocket error")),
  );
  ws.addEventListener("message", (event: MessageEvent<string>) => {
    try {
      const tick = parseFrame(event.data);
      if (tick) {
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

type BitstampDataFrame = {
  event?: string;
  channel?: string;
  data?: {
    bids?: ReadonlyArray<readonly [string, string]>;
    asks?: ReadonlyArray<readonly [string, string]>;
    microtimestamp?: string;
  };
};

function parseFrame(raw: string): QuoteTick | null {
  const data = JSON.parse(raw) as BitstampDataFrame;
  if (data.event !== "data" || data.channel !== channel || !data.data) {
    return null;
  }
  const topBid = data.data.bids?.[0]?.[0];
  const topAsk = data.data.asks?.[0]?.[0];
  if (typeof topBid !== "string" || typeof topAsk !== "string") {
    return null;
  }
  const bid = Number(topBid);
  const ask = Number(topAsk);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
    return null;
  }
  const tsExchangeMs = data.data.microtimestamp
    ? Math.floor(Number(data.data.microtimestamp) / 1000)
    : null;
  return {
    exchange: "bitstamp-spot",
    asset: "btc",
    tsReceivedMs: Date.now(),
    tsExchangeMs:
      tsExchangeMs && Number.isFinite(tsExchangeMs) ? tsExchangeMs : null,
    bid,
    ask,
    mid: (bid + ask) / 2,
  };
}
