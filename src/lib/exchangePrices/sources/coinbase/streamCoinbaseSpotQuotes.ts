import {
  applyCoinbaseLevel2Frame,
  createCoinbaseLevel2State,
} from "@alea/lib/exchangePrices/sources/coinbase/applyCoinbaseLevel2Frame";
import type {
  StreamHandle,
  StreamQuotesParams,
} from "@alea/lib/exchangePrices/types";

const url = "wss://advanced-trade-ws.coinbase.com";
const productId = "BTC-USD";

/**
 * Subscribes to the Coinbase Advanced Trade `level2` channel for BTC-USD.
 * The previous `ticker` channel only fired on trades (~2-5 Hz on BTC) so it
 * lagged any BBO move that wasn't accompanied by a print; the level2 channel
 * fires on every order-book change, giving us 50+ Hz on the same instrument.
 *
 * Each frame carries a snapshot or incremental updates; we maintain a small
 * book and only emit a `QuoteTick` when the best bid or best ask actually
 * moves — the rest of the depth churn is noise we don't care about.
 */
export function streamCoinbaseSpotQuotes({
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
    onError(new Error("coinbase-spot websocket error")),
  );
  ws.addEventListener("message", (event: MessageEvent<string>) => {
    try {
      const tick = applyCoinbaseLevel2Frame({
        raw: event.data,
        productId,
        exchange: "coinbase-spot",
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
