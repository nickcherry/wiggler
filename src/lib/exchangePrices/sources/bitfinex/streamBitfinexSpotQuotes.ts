import type {
  StreamHandle,
  StreamQuotesParams,
} from "@wiggler/lib/exchangePrices/types";
import type { QuoteTick } from "@wiggler/types/exchanges";

const url = "wss://api-pub.bitfinex.com/ws/2";
const symbol = "tBTCUSD";

/**
 * Subscribes to the Bitfinex v2 `ticker` channel for tBTCUSD. The first
 * server frame is `{ event: "subscribed", chanId, ... }`; we capture
 * `chanId` and from then on inspect `[chanId, [...]]` data frames whose
 * payload begins with [BID, BID_SIZE, ASK, ASK_SIZE, ...].
 */
export function streamBitfinexSpotQuotes({
  onTick,
  onError,
  onOpen,
  onClose,
}: StreamQuotesParams): StreamHandle {
  const ws = new WebSocket(url);
  let chanId: number | null = null;

  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({ event: "subscribe", channel: "ticker", symbol }),
    );
    onOpen?.();
  });
  ws.addEventListener("close", () => onClose?.());
  ws.addEventListener("error", () =>
    onError(new Error("bitfinex-spot websocket error")),
  );
  ws.addEventListener("message", (event: MessageEvent<string>) => {
    try {
      const parsed = JSON.parse(event.data) as unknown;
      if (chanId === null) {
        chanId = readChanIdFromSubscribed(parsed);
        return;
      }
      const tick = parseTickerFrame({ frame: parsed, chanId });
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

function readChanIdFromSubscribed(parsed: unknown): number | null {
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "event" in parsed &&
    (parsed as { event: string }).event === "subscribed" &&
    "chanId" in parsed
  ) {
    const id = (parsed as { chanId: number }).chanId;
    if (typeof id === "number") return id;
  }
  return null;
}

function parseTickerFrame({
  frame,
  chanId,
}: {
  readonly frame: unknown;
  readonly chanId: number;
}): QuoteTick | null {
  if (!Array.isArray(frame) || frame.length < 2) return null;
  if (frame[0] !== chanId) return null;
  const payload = frame[1];
  if (payload === "hb" || !Array.isArray(payload)) return null;
  const bid = Number(payload[0]);
  const ask = Number(payload[2]);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  return {
    exchange: "bitfinex-spot",
    tsReceivedMs: Date.now(),
    tsExchangeMs: null,
    bid,
    ask,
    mid: (bid + ask) / 2,
  };
}
