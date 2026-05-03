import { parseBybitOrderbookFrame } from "@wiggler/lib/exchangePrices/sources/bybit/parseBybitOrderbookFrame";
import type {
  StreamHandle,
  StreamQuotesParams,
} from "@wiggler/lib/exchangePrices/types";

const url = "wss://stream.bybit.com/v5/public/spot";
const topic = "orderbook.1.BTCUSDT";

/**
 * Subscribes to Bybit v5 public spot `orderbook.1.BTCUSDT` (top-of-book
 * depth feed). Subscribe shape: { op: "subscribe", args: [topic] }.
 * Bybit sends one snapshot then deltas; both are passed through the same
 * parser which keeps the best bid/ask in a small state object.
 */
export function streamBybitSpotQuotes({
  onTick,
  onError,
  onOpen,
  onClose,
}: StreamQuotesParams): StreamHandle {
  const ws = new WebSocket(url);
  const state = { bid: null as number | null, ask: null as number | null };

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ op: "subscribe", args: [topic] }));
    onOpen?.();
  });
  ws.addEventListener("close", () => onClose?.());
  ws.addEventListener("error", () =>
    onError(new Error("bybit-spot websocket error")),
  );
  ws.addEventListener("message", (event: MessageEvent<string>) => {
    try {
      const tick = parseBybitOrderbookFrame({
        raw: event.data,
        topic,
        exchange: "bybit-spot",
        state,
      });
      if (tick) {onTick(tick);}
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
