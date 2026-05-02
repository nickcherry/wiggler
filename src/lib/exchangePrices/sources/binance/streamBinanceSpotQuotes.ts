import type {
  StreamHandle,
  StreamQuotesParams,
} from "@wiggler/lib/exchangePrices/types";
import type { QuoteTick } from "@wiggler/types/exchanges";

// `stream.binance.com` is geo-blocked from many residential IPs; the
// `data-stream.binance.vision` mirror serves the same public market-data
// streams without those restrictions.
const url = "wss://data-stream.binance.vision/ws/btcusdt@bookTicker";

/**
 * Subscribes to Binance spot BTCUSDT best-bid/best-ask updates. Each frame
 * carries the new top of book; we push a `QuoteTick` immediately.
 *
 * Frame shape:
 *   { u, s, b, B, a, A } — bestBidPrice, bestBidQty, bestAskPrice, bestAskQty
 *   Note: bookTicker frames don't carry an event time, so tsExchangeMs is null.
 */
export function streamBinanceSpotQuotes({
  onTick,
  onError,
  onOpen,
  onClose,
}: StreamQuotesParams): StreamHandle {
  const ws = new WebSocket(url);

  ws.addEventListener("open", () => onOpen?.());
  ws.addEventListener("close", () => onClose?.());
  ws.addEventListener("error", () =>
    onError(new Error("binance-spot websocket error")),
  );
  ws.addEventListener("message", (event: MessageEvent<string>) => {
    try {
      const tick = parseFrame(event.data);
      if (tick) onTick(tick);
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

function parseFrame(raw: string): QuoteTick | null {
  const data = JSON.parse(raw) as { b?: string; a?: string };
  if (typeof data.b !== "string" || typeof data.a !== "string") {
    return null;
  }
  const bid = Number(data.b);
  const ask = Number(data.a);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  return {
    exchange: "binance-spot",
    tsReceivedMs: Date.now(),
    tsExchangeMs: null,
    bid,
    ask,
    mid: (bid + ask) / 2,
  };
}
