import { polymarket } from "@alea/constants/polymarket";
import { getPolymarketAuthState } from "@alea/lib/polymarket/getPolymarketClobClient";
import type { LeadingSide } from "@alea/lib/trading/types";
import type {
  FillEvent,
  TradableMarket,
  UserStreamCallbacks,
  UserStreamHandle,
} from "@alea/lib/trading/vendor/types";
import { z } from "zod";

const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
const HEARTBEAT_INTERVAL_MS = 8_000;

/**
 * Polymarket implementation of `Vendor.streamUserFills`. Maintains
 * a long-lived, auto-reconnecting subscription to `/ws/user` for our
 * wallet, narrowed to the conditionIds we currently care about.
 *
 * Translates Polymarket's free-form trade frames into the venue-
 * agnostic `FillEvent` shape the runner reads. Order status frames
 * (filled/cancelled) are observed but not surfaced — the runner
 * derives that state from incoming fills + its own placement
 * lifecycle.
 *
 * Reconnect uses the same exponential schedule as the Binance feed.
 * On every reconnect the venue treats the socket as a new session,
 * so we re-auth + re-subscribe inside `connect()`.
 */
export function streamPolymarketUserFills({
  markets,
  onFill,
  onConnect,
  onDisconnect,
  onError,
}: {
  readonly markets: readonly TradableMarket[];
} & UserStreamCallbacks): UserStreamHandle {
  const conditionIds = markets.map((m) => m.vendorRef);
  const tokenIdToSide = new Map<string, LeadingSide>();
  for (const market of markets) {
    tokenIdToSide.set(market.upRef, "up");
    tokenIdToSide.set(market.downRef, "down");
  }

  let stopped = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let attempt = 0;
  const seenFills = new Set<string>();

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = (reason: string) => {
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
      void connect();
    }, delay);
  };

  const clearHeartbeatTimer = () => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const connect = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    let creds: PolymarketCreds;
    try {
      const state = await getPolymarketAuthState();
      creds = extractCreds({ client: state.client });
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
      scheduleReconnect("auth-bootstrap-failed");
      return;
    }
    const ws = new WebSocket(polymarket.userWsUrl);
    socket = ws;
    let sawFirstFrame = false;

    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          auth: creds,
          type: "user",
          markets: [...conditionIds],
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
        for (const fill of parsePolymarketUserFillEvents({
          raw: event.data,
          tokenIdToSide,
          seenFills,
        })) {
          onFill(fill);
        }
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    });

    ws.addEventListener("error", () => {
      onError?.(new Error("polymarket user WS error"));
    });

    ws.addEventListener("close", (event: CloseEvent) => {
      socket = null;
      clearHeartbeatTimer();
      scheduleReconnect(
        event.reason.length > 0
          ? `user ws closed: ${event.reason}`
          : `user ws closed (code ${event.code})`,
      );
    });
  };

  void connect();

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
          // already closed
        }
      }
    },
  };
}

type PolymarketCreds = {
  readonly apiKey: string;
  readonly secret: string;
  readonly passphrase: string;
};

function extractCreds({
  client,
}: {
  readonly client: {
    readonly creds?: {
      apiKey?: string;
      key?: string;
      secret: string;
      passphrase: string;
    };
  };
}): PolymarketCreds {
  const creds = client.creds;
  if (!creds) {
    throw new Error("Polymarket client is missing API credentials.");
  }
  const apiKey = creds.key ?? creds.apiKey;
  if (apiKey === undefined) {
    throw new Error("Polymarket client credentials are missing apiKey.");
  }
  return { apiKey, secret: creds.secret, passphrase: creds.passphrase };
}

export function parsePolymarketUserFillEvents({
  raw,
  tokenIdToSide,
  seenFills,
}: {
  readonly raw: string;
  readonly tokenIdToSide: ReadonlyMap<string, LeadingSide>;
  readonly seenFills: Set<string>;
}): readonly FillEvent[] {
  if (raw.length === 0 || raw === "PONG") {
    return [];
  }
  const parsed = JSON.parse(raw);
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const fills: FillEvent[] = [];
  for (const item of items) {
    const trade = tradeFrameSchema.safeParse(item);
    if (!trade.success) {
      continue;
    }
    for (const event of mapTradeFrame({ frame: trade.data, tokenIdToSide })) {
      const eventId =
        trade.data.id ??
        `${trade.data.market}:${trade.data.timestamp ?? trade.data.match_time ?? trade.data.matchtime ?? trade.data.last_update ?? "unknown"}`;
      const key = `${eventId}:${event.outcomeRef}:${event.price}:${event.size}`;
      if (seenFills.has(key)) {
        continue;
      }
      seenFills.add(key);
      fills.push(event);
    }
  }
  return fills;
}

function mapTradeFrame({
  frame,
  tokenIdToSide,
}: {
  readonly frame: z.infer<typeof tradeFrameSchema>;
  readonly tokenIdToSide: ReadonlyMap<string, LeadingSide>;
}): readonly FillEvent[] {
  if (!tradeStatusCanFill({ status: frame.status })) {
    return [];
  }
  const events: FillEvent[] = [];
  for (const makerOrder of frame.maker_orders ?? []) {
    const side = tokenIdToSide.get(makerOrder.asset_id) ?? null;
    const price = Number(makerOrder.price);
    const size = Number(makerOrder.matched_amount);
    if (
      side === null ||
      !Number.isFinite(price) ||
      !Number.isFinite(size) ||
      size <= 0
    ) {
      continue;
    }
    events.push({
      vendorRef: frame.market,
      outcomeRef: makerOrder.asset_id,
      side,
      price,
      size,
      feeRateBps: 0,
      atMs: parseAtMs({
        matchTime: frame.match_time ?? frame.matchtime,
        lastUpdate: frame.last_update,
      }),
    });
  }
  if (events.length > 0) {
    return events;
  }
  const price = frame.price === undefined ? Number.NaN : Number(frame.price);
  const size = frame.size === undefined ? Number.NaN : Number(frame.size);
  const feeRateBps =
    frame.trader_side?.toUpperCase() === "MAKER" ||
    frame.fee_rate_bps === undefined
      ? 0
      : Number(frame.fee_rate_bps);
  if (
    !Number.isFinite(price) ||
    !Number.isFinite(size) ||
    !Number.isFinite(feeRateBps)
  ) {
    return [];
  }
  if (frame.asset_id === undefined) {
    return [];
  }
  const side = tokenIdToSide.get(frame.asset_id) ?? null;
  if (side === null) {
    return [];
  }
  const atMs = parseAtMs({
    matchTime: frame.match_time ?? frame.matchtime,
    lastUpdate: frame.last_update,
  });
  return [
    {
      vendorRef: frame.market,
      outcomeRef: frame.asset_id,
      side,
      price,
      size,
      feeRateBps,
      atMs,
    },
  ];
}

function tradeStatusCanFill({
  status,
}: {
  readonly status: string | undefined;
}): boolean {
  if (status === undefined) {
    return true;
  }
  const normalized = status.toUpperCase();
  return (
    normalized === "MATCHED" ||
    normalized === "MINED" ||
    normalized === "CONFIRMED"
  );
}

function parseAtMs({
  matchTime,
  lastUpdate,
}: {
  readonly matchTime?: string;
  readonly lastUpdate?: string;
}): number {
  for (const candidate of [matchTime, lastUpdate]) {
    if (typeof candidate === "string" && candidate.length > 0) {
      const numeric = Number(candidate);
      if (Number.isFinite(numeric)) {
        return numeric * 1000;
      }
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return Date.now();
}

const tradeFrameSchema = z
  .object({
    event_type: z.string().optional(),
    market: z.string(),
    id: z.string().optional(),
    asset_id: z.string().optional(),
    side: z.string().optional(),
    size: z.string().optional(),
    price: z.string().optional(),
    fee_rate_bps: z.string().optional(),
    status: z.string().optional(),
    trader_side: z.string().optional(),
    timestamp: z.string().optional(),
    match_time: z.string().optional(),
    matchtime: z.string().optional(),
    last_update: z.string().optional(),
    maker_orders: z
      .array(
        z
          .object({
            asset_id: z.string(),
            matched_amount: z.string(),
            price: z.string(),
            fee_rate_bps: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
