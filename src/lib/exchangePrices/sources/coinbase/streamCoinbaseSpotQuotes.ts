import type {
  StreamHandle,
  StreamQuotesParams,
} from "@wiggler/lib/exchangePrices/types";
import type { QuoteTick } from "@wiggler/types/exchanges";

const url = "wss://advanced-trade-ws.coinbase.com";

/**
 * Subscribes to the Coinbase Advanced Trade `ticker` channel for BTC-USD,
 * which fires on every best-bid or best-ask change. Public channel, no auth.
 *
 * Subscribe message: { type: "subscribe", channel: "ticker", product_ids:
 * ["BTC-USD"] }. Frames arrive grouped under `events[].tickers[]`.
 */
export function streamCoinbaseSpotQuotes({
  onTick,
  onError,
  onOpen,
  onClose,
}: StreamQuotesParams): StreamHandle {
  const ws = new WebSocket(url);

  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        type: "subscribe",
        channel: "ticker",
        product_ids: ["BTC-USD"],
      }),
    );
    onOpen?.();
  });
  ws.addEventListener("close", () => onClose?.());
  ws.addEventListener("error", () =>
    onError(new Error("coinbase-spot websocket error")),
  );
  ws.addEventListener("message", (event: MessageEvent<string>) => {
    try {
      const ticks = parseFrame(event.data);
      for (const tick of ticks) onTick(tick);
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

type CoinbaseTickerEvent = {
  events?: ReadonlyArray<{
    tickers?: ReadonlyArray<{
      product_id?: string;
      best_bid?: string;
      best_ask?: string;
    }>;
  }>;
  timestamp?: string;
};

function parseFrame(raw: string): QuoteTick[] {
  const data = JSON.parse(raw) as CoinbaseTickerEvent;
  if (!data.events) return [];
  const exchangeMs = data.timestamp ? Date.parse(data.timestamp) : null;
  const out: QuoteTick[] = [];
  for (const ev of data.events) {
    for (const ticker of ev.tickers ?? []) {
      if (ticker.product_id !== "BTC-USD") continue;
      const bid = Number(ticker.best_bid);
      const ask = Number(ticker.best_ask);
      if (!Number.isFinite(bid) || !Number.isFinite(ask)) continue;
      out.push({
        exchange: "coinbase-spot",
        tsReceivedMs: Date.now(),
        tsExchangeMs: Number.isFinite(exchangeMs) ? exchangeMs : null,
        bid,
        ask,
        mid: (bid + ask) / 2,
      });
    }
  }
  return out;
}
