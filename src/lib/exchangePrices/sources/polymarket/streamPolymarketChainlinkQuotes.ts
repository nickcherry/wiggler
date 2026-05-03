import type {
  StreamHandle,
  StreamQuotesParams,
} from "@wiggler/lib/exchangePrices/types";
import type { QuoteTick } from "@wiggler/types/exchanges";

const url = "wss://ws-live-data.polymarket.com";
const topic = "crypto_prices_chainlink";
const targetSymbol = "btc/usd";

/**
 * Subscribes to Polymarket's RTDS `crypto_prices_chainlink` topic and
 * surfaces BTC/USD updates. This is a single-value reference price
 * (Chainlink-derived) — there's no real bid/ask, so we set bid = ask =
 * value so a `polymarket-chainlink` tick slots into the existing BBO
 * data shape.
 *
 * Subscribe shape: { action: "subscribe", subscriptions: [{ topic, type: "*" }] }.
 * Frame shape:
 *   { topic: "crypto_prices_chainlink", type: "update",
 *     payload: { symbol: "btc/usd", value: number, timestamp: number },
 *     timestamp: number }
 *
 * The feed publishes all crypto symbols Polymarket cares about; we filter
 * to btc/usd so this matches the rest of the BBO comparison.
 */
export function streamPolymarketChainlinkQuotes({
  onTick,
  onError,
  onOpen,
  onClose,
}: StreamQuotesParams): StreamHandle {
  const ws = new WebSocket(url);

  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        action: "subscribe",
        subscriptions: [{ topic, type: "*" }],
      }),
    );
    onOpen?.();
  });
  ws.addEventListener("close", () => onClose?.());
  ws.addEventListener("error", () =>
    onError(new Error("polymarket-chainlink websocket error")),
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

type PolymarketRtdsFrame = {
  topic?: string;
  type?: string;
  timestamp?: number;
  payload?: { symbol?: string; value?: number; timestamp?: number };
};

function parseFrame(raw: string): QuoteTick | null {
  // RTDS sends occasional empty keep-alive frames; ignore them rather
  // than letting JSON.parse blow up.
  if (raw.length === 0) {
    return null;
  }
  const frame = JSON.parse(raw) as PolymarketRtdsFrame;
  if (frame.topic !== topic || frame.type !== "update" || !frame.payload) {
    return null;
  }
  if (frame.payload.symbol !== targetSymbol) {
    return null;
  }
  const value = Number(frame.payload.value);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  const tsExchangeMs =
    typeof frame.payload.timestamp === "number"
      ? frame.payload.timestamp
      : null;
  return {
    exchange: "polymarket-chainlink",
    tsReceivedMs: Date.now(),
    tsExchangeMs,
    bid: value,
    ask: value,
    mid: value,
  };
}
