import { binanceSymbol } from "@alea/lib/candles/sources/binance/binanceSymbol";
import type {
  StreamHandle,
  StreamQuotesParams,
} from "@alea/lib/exchangePrices/types";
import { createReconnectingWebSocket } from "@alea/lib/wsClient/createReconnectingWebSocket";
import type { Asset } from "@alea/types/assets";
import type { QuoteTick } from "@alea/types/exchanges";
import { z } from "zod";

// `stream.binance.com` is geo-blocked from many residential IPs; the
// `data-stream.binance.vision` mirror serves the same public market-
// data streams without those restrictions.
const SPOT_WS_BASE = "wss://data-stream.binance.vision/stream";

/**
 * Binance USDT spot BBO stream for one or more assets, served from a
 * single WebSocket connection via Binance's combined-stream URL.
 *
 * Replaces the previous single-asset implementation (BTCUSDT only,
 * no reconnect). Defaults `assets` to `["btc"]` so legacy
 * latency:capture experiments keep working unchanged.
 *
 * Spot bookTicker frames don't include an event time on the venue
 * side, so `tsExchangeMs` is always null.
 */
export function streamBinanceSpotQuotes({
  assets = ["btc"],
  onTick,
  onError,
  onOpen,
  onClose,
  onConnect,
  onDisconnect,
}: StreamQuotesParams): StreamHandle {
  const symbolToAsset = buildSymbolMap({ assets });
  const url = buildStreamUrl({ assets });

  const handle = createReconnectingWebSocket({
    label: "binance-spot",
    url,
    onOpen: () => onOpen?.(),
    onConnect,
    onDisconnect,
    onError,
    onMessage: (raw) => {
      try {
        const tick = parseFrame({ raw, symbolToAsset });
        if (tick) {
          onTick(tick);
        }
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

function buildStreamUrl({
  assets,
}: {
  readonly assets: readonly Asset[];
}): string {
  const streams = assets.map(
    (asset) => `${binanceSymbol({ asset }).toLowerCase()}@bookTicker`,
  );
  return `${SPOT_WS_BASE}?streams=${streams.join("/")}`;
}

function buildSymbolMap({
  assets,
}: {
  readonly assets: readonly Asset[];
}): ReadonlyMap<string, Asset> {
  const map = new Map<string, Asset>();
  for (const asset of assets) {
    map.set(binanceSymbol({ asset }), asset);
  }
  return map;
}

function parseFrame({
  raw,
  symbolToAsset,
}: {
  readonly raw: string;
  readonly symbolToAsset: ReadonlyMap<string, Asset>;
}): QuoteTick | null {
  const wrapper = combinedFrameSchema.safeParse(JSON.parse(raw));
  if (!wrapper.success) {
    return null;
  }
  const data = wrapper.data.data;
  const asset = symbolToAsset.get(data.s);
  if (asset === undefined) {
    return null;
  }
  const bid = Number(data.b);
  const ask = Number(data.a);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
    return null;
  }
  return {
    exchange: "binance-spot",
    asset,
    tsReceivedMs: Date.now(),
    tsExchangeMs: null,
    bid,
    ask,
    mid: (bid + ask) / 2,
  };
}

const bookTickerSchema = z.object({
  s: z.string(),
  b: z.string(),
  a: z.string(),
});

const combinedFrameSchema = z.object({
  stream: z.string(),
  data: bookTickerSchema,
});
