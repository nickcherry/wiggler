import { binancePerpSymbol } from "@alea/lib/candles/sources/binance/binancePerpSymbol";
import type {
  ClosedFiveMinuteBar,
  LivePriceFeedHandle,
  LivePriceFeedParams,
  LivePriceTick,
} from "@alea/lib/livePrices/types";
import type { Asset } from "@alea/types/assets";
import { z } from "zod";

const FAPI_WS_BASE = "wss://fstream.binance.com/stream";

/**
 * Backoff schedule for reconnects. Each entry is the delay before the
 * next connect attempt. The final entry is reused indefinitely; a
 * persistently-down feed should keep retrying rather than giving up.
 */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

/**
 * If we haven't seen any frame from the venue for this long, the
 * connection is considered dead and we force a reconnect. Binance's
 * BBO + kline streams are extremely chatty across all five assets — a
 * full second of total silence is already abnormal; 5s is comfortably
 * past the noise floor.
 */
const STALE_FRAME_THRESHOLD_MS = 5_000;

/**
 * One-process, one-WebSocket-at-a-time live feed for Binance USDT-M
 * perpetual futures across the requested asset set.
 *
 * Topology: a single combined stream subscription pulls best-bid/ask
 * (`<symbol>@bookTicker`) and 5m klines (`<symbol>@kline_5m`) for
 * every asset over one socket. Splitting per asset would multiply the
 * connection count without any latency benefit.
 *
 * Reliability:
 *   - Auto-reconnect with the backoff schedule above. Reconnect counter
 *     resets when a connection sees its first frame, so a brief network
 *     hiccup doesn't permanently saturate the backoff.
 *   - Stale-frame watchdog forces a reconnect when no message has been
 *     received for `STALE_FRAME_THRESHOLD_MS`. Standard WS keepalives
 *     mostly cover this, but the watchdog catches socket states the
 *     library doesn't surface as a `close`.
 *   - `stop()` cancels the pending reconnect timer and closes the
 *     socket cleanly.
 *
 * Boot hydration of recent closed bars (for EMA-50) lives in a
 * separate REST helper — this WS feed only emits bars that close
 * *while it's connected*. The dry-run / live runner is responsible
 * for stitching the two sources.
 */
export function streamBinancePerpLive({
  assets,
  onTick,
  onBarClose,
  onConnect,
  onDisconnect,
  onError,
}: LivePriceFeedParams): LivePriceFeedHandle {
  const url = buildStreamUrl({ assets });
  const symbolToAsset = buildSymbolMap({ assets });

  let stopped = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let lastFrameAtMs = 0;
  let attempt = 0;

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const clearWatchdog = () => {
    if (watchdog !== null) {
      clearInterval(watchdog);
      watchdog = null;
    }
  };

  const scheduleReconnect = (reason: string) => {
    if (stopped || reconnectTimer !== null) {
      return;
    }
    onDisconnect?.(reason);
    const delay =
      RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)] ??
      RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1] ??
      30_000;
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const connect = () => {
    if (stopped) {
      return;
    }
    clearWatchdog();
    const ws = new WebSocket(url);
    socket = ws;
    let sawFirstFrame = false;

    ws.addEventListener("open", () => {
      onConnect?.();
    });

    ws.addEventListener("message", (event: MessageEvent<string>) => {
      lastFrameAtMs = Date.now();
      if (!sawFirstFrame) {
        sawFirstFrame = true;
        attempt = 0;
      }
      try {
        handleFrame({
          raw: event.data,
          symbolToAsset,
          onTick,
          onBarClose,
        });
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    });

    ws.addEventListener("error", () => {
      onError?.(new Error("binance-perp live WS error"));
    });

    ws.addEventListener("close", (event: CloseEvent) => {
      socket = null;
      clearWatchdog();
      scheduleReconnect(
        event.reason.length > 0
          ? `socket closed: ${event.reason}`
          : `socket closed (code ${event.code})`,
      );
    });

    lastFrameAtMs = Date.now();
    watchdog = setInterval(() => {
      if (lastFrameAtMs === 0) {
        return;
      }
      if (Date.now() - lastFrameAtMs > STALE_FRAME_THRESHOLD_MS) {
        clearWatchdog();
        try {
          ws.close(4000, "stale-frame watchdog");
        } catch {
          // Closing a socket that's already torn down is fine — the
          // close handler above will still fire and trigger reconnect.
        }
      }
    }, 1_000);
  };

  connect();

  return {
    stop: async () => {
      stopped = true;
      clearReconnectTimer();
      clearWatchdog();
      const ws = socket;
      socket = null;
      if (ws !== null) {
        try {
          ws.close(1000, "shutdown");
        } catch {
          // ignore — caller is shutting down
        }
      }
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
  readonly onTick: (tick: LivePriceTick) => void;
  readonly onBarClose: (bar: ClosedFiveMinuteBar) => void;
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
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
      return;
    }
    onTick({
      asset,
      bid,
      ask,
      mid: (bid + ask) / 2,
      exchangeTimeMs:
        typeof data.T === "number"
          ? data.T
          : typeof data.E === "number"
            ? data.E
            : null,
      receivedAtMs: Date.now(),
    });
    return;
  }
  if (data.e === "kline") {
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
