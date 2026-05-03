import {
  applyCoinbaseLevel2Frame,
  createCoinbaseLevel2State,
} from "@wiggler/lib/exchangePrices/sources/coinbase/applyCoinbaseLevel2Frame";
import type {
  StreamHandle,
  StreamQuotesParams,
} from "@wiggler/lib/exchangePrices/types";

const url = "wss://advanced-trade-ws.coinbase.com";
// `BTC-PERP-INTX` is the BTC perpetual on Coinbase International Exchange,
// surfaced through the same Advanced Trade WebSocket as spot.
const productId = "BTC-PERP-INTX";

/**
 * Subscribes to the Coinbase Advanced Trade `level2` channel for the BTC
 * perpetual on Coinbase International. Same book-maintenance protocol as
 * spot — emits a `QuoteTick` only when the BBO actually moves.
 */
export function streamCoinbasePerpQuotes({
  onTick,
  onError,
  onOpen,
  onClose,
}: StreamQuotesParams): StreamHandle {
  const ws = new WebSocket(url);
  const state = createCoinbaseLevel2State();

  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        type: "subscribe",
        channel: "level2",
        product_ids: [productId],
      }),
    );
    onOpen?.();
  });
  ws.addEventListener("close", () => onClose?.());
  ws.addEventListener("error", () =>
    onError(new Error("coinbase-perp websocket error")),
  );
  ws.addEventListener("message", (event: MessageEvent<string>) => {
    try {
      const tick = applyCoinbaseLevel2Frame({
        raw: event.data,
        productId,
        exchange: "coinbase-perp",
        state,
      });
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
