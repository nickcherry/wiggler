import type {
  StreamHandle,
  StreamQuotesParams,
} from "@wiggler/lib/exchangePrices/types";
import type { QuoteTick } from "@wiggler/types/exchanges";

const url = "wss://ws.kraken.com/v2";

/**
 * Subscribes to Kraken v2 `ticker` channel for BTC/USD. Fires on every
 * BBO change. Subscribe shape:
 *   { method: "subscribe", params: { channel: "ticker", symbol: ["BTC/USD"] } }
 *
 * Data frames have `channel: "ticker"` and `data: [{ symbol, bid, ask, ... }]`.
 */
export function streamKrakenSpotQuotes({
  onTick,
  onError,
  onOpen,
  onClose,
}: StreamQuotesParams): StreamHandle {
  const ws = new WebSocket(url);

  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        method: "subscribe",
        params: { channel: "ticker", symbol: ["BTC/USD"] },
      }),
    );
    onOpen?.();
  });
  ws.addEventListener("close", () => onClose?.());
  ws.addEventListener("error", () =>
    onError(new Error("kraken-spot websocket error")),
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

type KrakenTickerFrame = {
  channel?: string;
  type?: string;
  data?: ReadonlyArray<{ symbol?: string; bid?: number; ask?: number }>;
};

function parseFrame(raw: string): QuoteTick[] {
  const data = JSON.parse(raw) as KrakenTickerFrame;
  if (data.channel !== "ticker") return [];
  if (!Array.isArray(data.data)) return [];
  const out: QuoteTick[] = [];
  for (const row of data.data) {
    if (row.symbol !== "BTC/USD") continue;
    const bid = Number(row.bid);
    const ask = Number(row.ask);
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) continue;
    out.push({
      exchange: "kraken-spot",
      tsReceivedMs: Date.now(),
      tsExchangeMs: null,
      bid,
      ask,
      mid: (bid + ask) / 2,
    });
  }
  return out;
}
