import { polymarket } from "@alea/constants/polymarket";
import type { LeadingSide } from "@alea/lib/trading/types";
import type {
  MarketDataEvent,
  MarketDataStreamCallbacks,
  MarketDataStreamHandle,
  PriceLevel,
  TradableMarket,
} from "@alea/lib/trading/vendor/types";
import { z } from "zod";

const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
const HEARTBEAT_INTERVAL_MS = 8_000;

export function streamPolymarketMarketData({
  markets,
  onEvent,
  onConnect,
  onDisconnect,
  onError,
}: {
  readonly markets: readonly TradableMarket[];
} & MarketDataStreamCallbacks): MarketDataStreamHandle {
  const tokenIds = markets.flatMap((market) => [market.upRef, market.downRef]);
  const tokenIdToSide = buildTokenIdToSide({ markets });

  let stopped = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let attempt = 0;

  const clearReconnectTimer = (): void => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };
  const clearHeartbeatTimer = (): void => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };
  const scheduleReconnect = (reason: string): void => {
    if (stopped || reconnectTimer !== null) {
      return;
    }
    clearHeartbeatTimer();
    onDisconnect?.(reason);
    const delay =
      RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)] ??
      30_000;
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const connect = (): void => {
    if (stopped) {
      return;
    }
    const ws = new WebSocket(polymarket.marketWsUrl);
    socket = ws;
    let sawFirstFrame = false;

    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          type: "market",
          assets_ids: tokenIds,
          custom_feature_enabled: true,
        }),
      );
      heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send("PING");
        }
      }, HEARTBEAT_INTERVAL_MS);
      onConnect?.();
    });

    ws.addEventListener("message", (event: MessageEvent<string>) => {
      if (!sawFirstFrame) {
        sawFirstFrame = true;
        attempt = 0;
      }
      try {
        for (const parsed of parsePolymarketMarketDataEvents({
          raw: event.data,
          tokenIdToSide,
        })) {
          onEvent(parsed);
        }
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    });

    ws.addEventListener("error", () => {
      onError?.(new Error("polymarket market WS error"));
    });

    ws.addEventListener("close", (event: CloseEvent) => {
      socket = null;
      clearHeartbeatTimer();
      scheduleReconnect(
        event.reason.length > 0
          ? `market ws closed: ${event.reason}`
          : `market ws closed (code ${event.code})`,
      );
    });
  };

  connect();

  return {
    stop: async () => {
      stopped = true;
      clearReconnectTimer();
      clearHeartbeatTimer();
      const ws = socket;
      socket = null;
      if (ws !== null) {
        try {
          ws.close(1000, "shutdown");
        } catch {
          // caller is shutting down
        }
      }
    },
  };
}

export function parsePolymarketMarketDataEvents({
  raw,
  tokenIdToSide,
}: {
  readonly raw: string;
  readonly tokenIdToSide: ReadonlyMap<string, LeadingSide>;
}): readonly MarketDataEvent[] {
  if (raw.length === 0 || raw === "PONG") {
    return [];
  }
  const parsed = JSON.parse(raw);
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const out: MarketDataEvent[] = [];
  for (const item of items) {
    const frame = marketFrameSchema.safeParse(item);
    if (!frame.success) {
      continue;
    }
    const eventType = frame.data.event_type ?? frame.data.type;
    if (eventType === "book") {
      const outcomeRef = frame.data.asset_id ?? frame.data.asset;
      if (outcomeRef === undefined) {
        continue;
      }
      out.push({
        kind: "book",
        vendorRef: frame.data.market ?? null,
        outcomeRef,
        bids: parseLevels({ levels: frame.data.bids ?? [] }),
        asks: parseLevels({ levels: frame.data.asks ?? [] }),
        atMs: parseAtMs(frame.data.timestamp),
      });
      continue;
    }
    if (eventType === "best_bid_ask") {
      const outcomeRef = frame.data.asset_id ?? frame.data.asset;
      if (outcomeRef === undefined) {
        continue;
      }
      out.push({
        kind: "best-bid-ask",
        vendorRef: frame.data.market ?? null,
        outcomeRef,
        bestBid: parseNullableNumber(
          frame.data.best_bid ?? frame.data.bid ?? frame.data.b,
        ),
        bestAsk: parseNullableNumber(
          frame.data.best_ask ?? frame.data.ask ?? frame.data.a,
        ),
        atMs: parseAtMs(frame.data.timestamp),
      });
      continue;
    }
    if (eventType === "price_change") {
      const changes = frame.data.changes ?? [frame.data];
      for (const change of changes) {
        const outcomeRef = change.asset_id ?? change.asset;
        const price = parseNullableNumber(change.price);
        if (outcomeRef === undefined || price === null) {
          continue;
        }
        out.push({
          kind: "price-change",
          vendorRef: change.market ?? frame.data.market ?? null,
          outcomeRef,
          price,
          side: parseTradeSide(change.side),
          size: parseNullableNumber(change.size),
          atMs: parseAtMs(change.timestamp ?? frame.data.timestamp),
        });
      }
      continue;
    }
    if (eventType === "last_trade_price") {
      const outcomeRef = frame.data.asset_id ?? frame.data.asset;
      const price = parseNullableNumber(frame.data.price);
      if (outcomeRef === undefined || price === null) {
        continue;
      }
      out.push({
        kind: "trade",
        vendorRef: frame.data.market ?? null,
        outcomeRef,
        price,
        size: parseNullableNumber(frame.data.size),
        side: parseTradeSide(frame.data.side),
        atMs: parseAtMs(frame.data.timestamp),
      });
      continue;
    }
    if (eventType === "tick_size_change") {
      const next = parseNullableNumber(
        frame.data.new_tick_size ?? frame.data.tick_size,
      );
      if (next === null) {
        continue;
      }
      out.push({
        kind: "tick-size-change",
        vendorRef: frame.data.market ?? null,
        outcomeRef: frame.data.asset_id ?? frame.data.asset ?? null,
        oldTickSize: parseNullableNumber(frame.data.old_tick_size),
        newTickSize: next,
        atMs: parseAtMs(frame.data.timestamp),
      });
      continue;
    }
    if (eventType === "market_resolved") {
      const outcomeRef =
        frame.data.winning_asset_id ??
        frame.data.winning_asset ??
        frame.data.asset_id ??
        frame.data.asset ??
        null;
      out.push({
        kind: "resolved",
        vendorRef: frame.data.market ?? frame.data.condition_id ?? "",
        winningOutcomeRef: outcomeRef,
        winningSide:
          outcomeRef === null ? null : tokenIdToSide.get(outcomeRef) ?? null,
        atMs: parseAtMs(frame.data.timestamp),
      });
    }
  }
  return out.filter(
    (event) => event.kind !== "resolved" || event.vendorRef.length > 0,
  );
}

function buildTokenIdToSide({
  markets,
}: {
  readonly markets: readonly TradableMarket[];
}): ReadonlyMap<string, LeadingSide> {
  const map = new Map<string, LeadingSide>();
  for (const market of markets) {
    map.set(market.upRef, "up");
    map.set(market.downRef, "down");
  }
  return map;
}

function parseLevels({
  levels,
}: {
  readonly levels: readonly z.infer<typeof levelSchema>[];
}): PriceLevel[] {
  const out: PriceLevel[] = [];
  for (const level of levels) {
    const price = Number(level.price);
    const size = Number(level.size);
    if (
      !Number.isFinite(price) ||
      !Number.isFinite(size) ||
      price <= 0 ||
      size <= 0
    ) {
      continue;
    }
    out.push({ price, size });
  }
  return out;
}

function parseNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseTradeSide(value: unknown): "BUY" | "SELL" | null {
  if (typeof value !== "string") {
    return null;
  }
  const upper = value.toUpperCase();
  return upper === "BUY" || upper === "SELL" ? upper : null;
}

function parseAtMs(value: unknown): number {
  const numeric = parseNullableNumber(value);
  if (numeric !== null) {
    return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Date.now();
}

const levelSchema = z
  .object({
    price: z.union([z.string(), z.number()]),
    size: z.union([z.string(), z.number()]),
  })
  .passthrough();

const changeSchema = z
  .object({
    market: z.string().optional(),
    asset_id: z.string().optional(),
    asset: z.string().optional(),
    price: z.union([z.string(), z.number()]).optional(),
    size: z.union([z.string(), z.number()]).optional(),
    side: z.string().optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

const marketFrameSchema = z
  .object({
    event_type: z.string().optional(),
    type: z.string().optional(),
    market: z.string().optional(),
    condition_id: z.string().optional(),
    asset_id: z.string().optional(),
    asset: z.string().optional(),
    winning_asset_id: z.string().optional(),
    winning_asset: z.string().optional(),
    price: z.union([z.string(), z.number()]).optional(),
    size: z.union([z.string(), z.number()]).optional(),
    side: z.string().optional(),
    best_bid: z.union([z.string(), z.number()]).optional(),
    best_ask: z.union([z.string(), z.number()]).optional(),
    bid: z.union([z.string(), z.number()]).optional(),
    ask: z.union([z.string(), z.number()]).optional(),
    b: z.union([z.string(), z.number()]).optional(),
    a: z.union([z.string(), z.number()]).optional(),
    old_tick_size: z.union([z.string(), z.number()]).optional(),
    new_tick_size: z.union([z.string(), z.number()]).optional(),
    tick_size: z.union([z.string(), z.number()]).optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
    bids: z.array(levelSchema).optional(),
    asks: z.array(levelSchema).optional(),
    changes: z.array(changeSchema).optional(),
  })
  .passthrough();
