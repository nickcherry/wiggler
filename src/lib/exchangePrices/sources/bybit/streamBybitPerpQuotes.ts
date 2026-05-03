import { parseBybitOrderbookFrame } from "@wiggler/lib/exchangePrices/sources/bybit/parseBybitOrderbookFrame";
import type {
  StreamHandle,
  StreamQuotesParams,
} from "@wiggler/lib/exchangePrices/types";

const url = "wss://stream.bybit.com/v5/public/linear";
const topic = "orderbook.1.BTCUSDT";

/**
 * Subscribes to Bybit v5 public USDT perpetual `orderbook.1.BTCUSDT`.
 * Same channel shape as spot — only the WS endpoint differs.
 */
export function streamBybitPerpQuotes({
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
    onError(new Error("bybit-perp websocket error")),
  );
  ws.addEventListener("message", (event: MessageEvent<string>) => {
    try {
      const tick = parseBybitOrderbookFrame({
        raw: event.data,
        topic,
        exchange: "bybit-perp",
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
