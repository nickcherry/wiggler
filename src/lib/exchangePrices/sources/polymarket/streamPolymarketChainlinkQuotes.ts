import type {
  StreamHandle,
  StreamQuotesParams,
} from "@alea/lib/exchangePrices/types";
import { createReconnectingWebSocket } from "@alea/lib/wsClient/createReconnectingWebSocket";
import type { Asset } from "@alea/types/assets";

const url = "wss://ws-live-data.polymarket.com";
const topic = "crypto_prices_chainlink";

/**
 * Subscribes to Polymarket's RTDS `crypto_prices_chainlink` topic and
 * surfaces `<asset>/usd` reference price updates. This is a
 * single-value Chainlink-derived reference price (not a true BBO),
 * so we set `bid = ask = mid = value` to slot it into the existing
 * `QuoteTick` shape.
 *
 * The RTDS topic carries every crypto symbol Polymarket publishes
 * on a single connection; we filter to the requested `assets`.
 *
 * Defaults `assets` to `["btc"]` so the latency:capture experiments
 * keep working unchanged.
 *
 * Reliability: backed by `wsClient/createReconnectingWebSocket` —
 * auto-reconnect with backoff, stale-frame watchdog. The subscription
 * is re-sent on every (re)connect.
 *
 * Polymarket is the venue we trade against; the Chainlink-derived
 * reference IS the true settlement source for the up/down 5m markets.
 * This is the only feed for which Polymarket and "the source of
 * truth" coincide, so capturing it directly is critical for proxy-
 * mismatch research (the Binance vs. Chainlink divergence that
 * occasionally hands us wrong-side fills).
 */
export function streamPolymarketChainlinkQuotes({
  assets = ["btc"],
  onTick,
  onError,
  onOpen,
  onClose,
  onConnect,
  onDisconnect,
}: StreamQuotesParams): StreamHandle {
  const symbolToAsset = buildSymbolMap({ assets });

  const handle = createReconnectingWebSocket({
    label: "polymarket-chainlink",
    url,
    onOpen: (ws) => {
      ws.send(
        JSON.stringify({
          action: "subscribe",
          subscriptions: [{ topic, type: "*" }],
        }),
      );
      onOpen?.();
    },
    onConnect,
    onDisconnect,
    onError,
    onMessage: (raw) => {
      try {
        // RTDS sends occasional empty keep-alive frames; ignore them
        // rather than letting JSON.parse blow up.
        if (raw.length === 0) {
          return;
        }
        const frame = JSON.parse(raw) as PolymarketRtdsFrame;
        if (frame.topic !== topic || frame.type !== "update" || !frame.payload) {
          return;
        }
        const symbol = frame.payload.symbol ?? "";
        const asset = symbolToAsset.get(symbol);
        if (asset === undefined) {
          return;
        }
        const value = Number(frame.payload.value);
        if (!Number.isFinite(value) || value <= 0) {
          return;
        }
        const tsExchangeMs =
          typeof frame.payload.timestamp === "number"
            ? frame.payload.timestamp
            : null;
        onTick({
          exchange: "polymarket-chainlink",
          asset,
          tsReceivedMs: Date.now(),
          tsExchangeMs,
          bid: value,
          ask: value,
          mid: value,
        });
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });

  return {
    stop: async () => {
      await handle.stop();
      onClose?.();
    },
  };
}

type PolymarketRtdsFrame = {
  topic?: string;
  type?: string;
  timestamp?: number;
  payload?: { symbol?: string; value?: number; timestamp?: number };
};

function buildSymbolMap({
  assets,
}: {
  readonly assets: readonly Asset[];
}): ReadonlyMap<string, Asset> {
  const map = new Map<string, Asset>();
  for (const asset of assets) {
    map.set(`${asset}/usd`, asset);
  }
  return map;
}
