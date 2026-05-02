import type {
  StreamHandle,
  StreamQuotesParams,
} from "@wiggler/lib/exchangePrices/types";
import type { QuoteTick } from "@wiggler/types/exchanges";

const url = "wss://fstream.binance.com/ws/btcusdt@bookTicker";

/**
 * Subscribes to Binance USDT-M perpetual futures BTCUSDT best-bid/best-ask
 * updates. Frame shape mirrors spot but does carry an `E` (event time, ms),
 * so tsExchangeMs is populated.
 */
export function streamBinancePerpQuotes({
  onTick,
  onError,
  onOpen,
  onClose,
}: StreamQuotesParams): StreamHandle {
  const ws = new WebSocket(url);

  ws.addEventListener("open", () => onOpen?.());
  ws.addEventListener("close", () => onClose?.());
  ws.addEventListener("error", () =>
    onError(new Error("binance-perp websocket error")),
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
  const data = JSON.parse(raw) as {
    b?: string;
    a?: string;
    E?: number;
    T?: number;
  };
  if (typeof data.b !== "string" || typeof data.a !== "string") {
    return null;
  }
  const bid = Number(data.b);
  const ask = Number(data.a);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  const exchangeMs = typeof data.T === "number" ? data.T : data.E ?? null;
  return {
    exchange: "binance-perp",
    tsReceivedMs: Date.now(),
    tsExchangeMs: exchangeMs,
    bid,
    ask,
    mid: (bid + ask) / 2,
  };
}
