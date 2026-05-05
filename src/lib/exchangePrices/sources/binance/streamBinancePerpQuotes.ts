import { binancePerpSymbol } from "@alea/lib/candles/sources/binance/binancePerpSymbol";
import type {
  ClosedBarTick,
  StreamHandle,
  StreamQuotesParams,
} from "@alea/lib/exchangePrices/types";
import { createReconnectingWebSocket } from "@alea/lib/wsClient/createReconnectingWebSocket";
import type { Asset } from "@alea/types/assets";
import type { QuoteTick } from "@alea/types/exchanges";
import { z } from "zod";

const FAPI_WS_BASE = "wss://fstream.binance.com/stream";

/**
 * Binance USDT-margined perpetual futures BBO + 5m kline-close stream
 * for one or more assets, served from a single WebSocket connection
 * via Binance's combined-stream URL (`/stream?streams=...`).
 *
 * This replaces both the old single-asset experiment-grade
 * `streamBinancePerpQuotes` and the trader-side `streamBinancePerpLive`.
 *
 * Reliability:
 *   - Reconnect with exponential-style backoff via the shared
 *     `wsClient/createReconnectingWebSocket` helper.
 *   - Stale-frame watchdog (default 30s) forces reconnect on
 *     half-open sockets the underlying client doesn't surface.
 *   - `attempt` counter resets after the first frame of each
 *     successful connection so a brief blip doesn't permanently
 *     saturate the schedule.
 *
 * Defaults to `["btc"]` so legacy single-asset callers (the
 * latency:capture experiments, etc.) keep working without code
 * changes.
 *
 * Frame shape — `bookTicker` and `kline_5m` events arrive on the
 * same socket multiplexed under `data.e`. We populate `tsExchangeMs`
 * from the venue's `T` (transaction time) when present, falling back
 * to `E` (event time).
 */
export function streamBinancePerpQuotes({
  assets = ["btc"],
  onTick,
  onError,
  onOpen,
  onClose,
  onConnect,
  onDisconnect,
  onBarClose,
}: StreamQuotesParams): StreamHandle {
  const symbolToAsset = buildSymbolMap({ assets });
  const url = buildStreamUrl({ assets });

  const handle = createReconnectingWebSocket({
    label: "binance-perp",
    url,
    onOpen: () => onOpen?.(),
    onConnect,
    onDisconnect,
    onError,
    onMessage: (raw) => {
      try {
        handleFrame({ raw, symbolToAsset, onTick, onBarClose });
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
  const streams: string[] = [];
  for (const asset of assets) {
    const symbol = binancePerpSymbol({ asset }).toLowerCase();
    streams.push(`${symbol}@bookTicker`);
    streams.push(`${symbol}@kline_5m`);
  }
  return `${FAPI_WS_BASE}?streams=${streams.join("/")}`;
}

function buildSymbolMap({
  assets,
}: {
  readonly assets: readonly Asset[];
}): ReadonlyMap<string, Asset> {
  const map = new Map<string, Asset>();
  for (const asset of assets) {
    map.set(binancePerpSymbol({ asset }), asset);
  }
  return map;
}

function handleFrame({
  raw,
  symbolToAsset,
  onTick,
  onBarClose,
}: {
  readonly raw: string;
  readonly symbolToAsset: ReadonlyMap<string, Asset>;
  readonly onTick: (tick: QuoteTick) => void;
  readonly onBarClose?: (bar: ClosedBarTick) => void;
}): void {
  const wrapper = combinedFrameSchema.safeParse(JSON.parse(raw));
  if (!wrapper.success) {
    return;
  }
  const data = wrapper.data.data;
  if (data.e === "bookTicker") {
    const asset = symbolToAsset.get(data.s);
    if (asset === undefined) {
      return;
    }
    const bid = Number(data.b);
    const ask = Number(data.a);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
      return;
    }
    onTick({
      exchange: "binance-perp",
      asset,
      tsReceivedMs: Date.now(),
      tsExchangeMs:
        typeof data.T === "number"
          ? data.T
          : typeof data.E === "number"
            ? data.E
            : null,
      bid,
      ask,
      mid: (bid + ask) / 2,
    });
    return;
  }
  if (data.e === "kline" && onBarClose !== undefined) {
    if (!data.k.x) {
      return;
    }
    const asset = symbolToAsset.get(data.k.s);
    if (asset === undefined) {
      return;
    }
    const open = Number(data.k.o);
    const high = Number(data.k.h);
    const low = Number(data.k.l);
    const close = Number(data.k.c);
    if (
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close)
    ) {
      return;
    }
    onBarClose({
      exchange: "binance-perp",
      asset,
      openTimeMs: data.k.t,
      closeTimeMs: data.k.T,
      open,
      high,
      low,
      close,
    });
  }
}

const bookTickerSchema = z.object({
  e: z.literal("bookTicker"),
  s: z.string(),
  b: z.string(),
  a: z.string(),
  E: z.number().optional(),
  T: z.number().optional(),
});

const klineSchema = z.object({
  e: z.literal("kline"),
  k: z.object({
    s: z.string(),
    t: z.number(),
    T: z.number(),
    o: z.string(),
    h: z.string(),
    l: z.string(),
    c: z.string(),
    x: z.boolean(),
  }),
});

const combinedFrameSchema = z.object({
  stream: z.string(),
  data: z.union([bookTickerSchema, klineSchema]),
});
