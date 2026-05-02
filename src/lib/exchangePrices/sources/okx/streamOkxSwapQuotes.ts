import { parseOkxBboFrame } from "@wiggler/lib/exchangePrices/sources/okx/parseOkxBboFrame";
import type {
  StreamHandle,
  StreamQuotesParams,
} from "@wiggler/lib/exchangePrices/types";

const url = "wss://ws.okx.com:8443/ws/v5/public";
const instId = "BTC-USDT-SWAP";

/**
 * Subscribes to OKX v5 `bbo-tbt` for the BTC-USDT-SWAP perpetual contract.
 * Same channel and frame shape as spot — only `instId` differs.
 */
export function streamOkxSwapQuotes({
  onTick,
  onError,
  onOpen,
  onClose,
}: StreamQuotesParams): StreamHandle {
  const ws = new WebSocket(url);

  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        op: "subscribe",
        args: [{ channel: "bbo-tbt", instId }],
      }),
    );
    onOpen?.();
  });
  ws.addEventListener("close", () => onClose?.());
  ws.addEventListener("error", () =>
    onError(new Error("okx-swap websocket error")),
  );
  ws.addEventListener("message", (event: MessageEvent<string>) => {
    try {
      const tick = parseOkxBboFrame({
        raw: event.data,
        instId,
        exchange: "okx-swap",
      });
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
