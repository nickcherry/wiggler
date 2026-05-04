import { polymarket } from "@alea/constants/polymarket";
import { getPolymarketAuthState } from "@alea/lib/polymarket/getPolymarketClobClient";
import { z } from "zod";

const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

/**
 * One trade fill, normalized into the shape the runner reads. The
 * Polymarket user WS channel publishes the venue's `Trade` payload
 * verbatim — we only surface the fields we use plus an `asOfMs`
 * for ordering across reconnect boundaries.
 */
export type UserChannelFillEvent = {
  readonly conditionId: string;
  readonly tokenId: string;
  readonly orderId: string | null;
  readonly takerOrMaker: "MAKER" | "TAKER";
  readonly price: number;
  readonly size: number;
  readonly feeRateBps: number;
  readonly status: string;
  readonly atMs: number;
};

/**
 * Order-status update — fires when an open order is filled, partially
 * filled, or cancelled. The runner uses this to clear the resting slot
 * when a cancel completes; fills come in via the trade channel.
 */
export type UserChannelOrderEvent = {
  readonly conditionId: string;
  readonly orderId: string;
  readonly status: string;
  readonly originalSize: number;
  readonly sizeMatched: number;
  readonly atMs: number;
};

export type UserChannelHandle = {
  readonly stop: () => Promise<void>;
};

export type UserChannelParams = {
  /**
   * Markets we want updates for, identified by their conditionId. The
   * Polymarket WS subscribe frame expects `markets: string[]`. Empty
   * list means "everything for this user", but we never want that —
   * the bot is responsible for narrowing.
   */
  readonly conditionIds: readonly string[];
  readonly onFill: (event: UserChannelFillEvent) => void;
  readonly onOrderEvent?: (event: UserChannelOrderEvent) => void;
  readonly onConnect?: () => void;
  readonly onDisconnect?: (reason: string) => void;
  readonly onError?: (error: Error) => void;
};

/**
 * Long-lived, auto-reconnecting subscription to Polymarket's
 * `/ws/user` channel for our wallet. Emits `onFill` whenever the
 * venue reports a trade hitting one of our orders. Same connection
 * also surfaces order-status changes (cancelled, filled, etc.) via
 * `onOrderEvent`.
 *
 * The channel needs L2 (HMAC) credentials, so this depends on the
 * canonical `getPolymarketAuthState` boot. Reconnect uses the same
 * exponential schedule the price feed does; we re-auth on every
 * reconnect because the venue treats each socket independently.
 */
export function streamUserChannel({
  conditionIds,
  onFill,
  onOrderEvent,
  onConnect,
  onDisconnect,
  onError,
}: UserChannelParams): UserChannelHandle {
  let stopped = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

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

  const connect = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    let authBundle: {
      readonly apiKey: string;
      readonly secret: string;
      readonly passphrase: string;
    } | null = null;
    try {
      const state = await getPolymarketAuthState();
      authBundle = extractCreds({ client: state.client });
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
          auth: {
            apiKey: authBundle.apiKey,
            secret: authBundle.secret,
            passphrase: authBundle.passphrase,
          },
          type: "user",
          markets: [...conditionIds],
        }),
      );
      onConnect?.();
    });

    ws.addEventListener("message", (event: MessageEvent<string>) => {
      if (!sawFirstFrame) {
        sawFirstFrame = true;
        attempt = 0;
      }
      try {
        handleFrame({ raw: event.data, onFill, onOrderEvent });
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    });

    ws.addEventListener("error", () => {
      onError?.(new Error("polymarket user WS error"));
    });

    ws.addEventListener("close", (event: CloseEvent) => {
      socket = null;
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
      const ws = socket;
      socket = null;
      if (ws !== null) {
        try {
          ws.close(1000, "shutdown");
        } catch {
          // ignore
        }
      }
    },
  };
}

function handleFrame({
  raw,
  onFill,
  onOrderEvent,
}: {
  readonly raw: string;
  readonly onFill: (event: UserChannelFillEvent) => void;
  readonly onOrderEvent: ((event: UserChannelOrderEvent) => void) | undefined;
}): void {
  if (raw.length === 0) {
    return;
  }
  const parsed = JSON.parse(raw);
  // The user channel publishes either a single object or a batched
  // array — normalize before fanning out.
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of items) {
    const trade = tradeFrameSchema.safeParse(item);
    if (trade.success) {
      const ev = mapTradeFrame({ frame: trade.data });
      if (ev !== null) {
        onFill(ev);
        continue;
      }
    }
    const order = orderFrameSchema.safeParse(item);
    if (order.success && onOrderEvent !== undefined) {
      const ev = mapOrderFrame({ frame: order.data });
      if (ev !== null) {
        onOrderEvent(ev);
      }
    }
  }
}

function mapTradeFrame({
  frame,
}: {
  readonly frame: z.infer<typeof tradeFrameSchema>;
}): UserChannelFillEvent | null {
  const price = Number(frame.price);
  const size = Number(frame.size);
  const feeRateBps = Number(frame.fee_rate_bps);
  if (
    !Number.isFinite(price) ||
    !Number.isFinite(size) ||
    !Number.isFinite(feeRateBps)
  ) {
    return null;
  }
  const trader =
    frame.trader_side === "MAKER" || frame.trader_side === "TAKER"
      ? frame.trader_side
      : "MAKER";
  const atMs = parseAtMs({
    matchTime: frame.match_time,
    lastUpdate: frame.last_update,
  });
  return {
    conditionId: frame.market,
    tokenId: frame.asset_id,
    orderId:
      typeof frame.taker_order_id === "string" ? frame.taker_order_id : null,
    takerOrMaker: trader,
    price,
    size,
    feeRateBps,
    status: frame.status ?? "",
    atMs,
  };
}

function mapOrderFrame({
  frame,
}: {
  readonly frame: z.infer<typeof orderFrameSchema>;
}): UserChannelOrderEvent | null {
  const originalSize = Number(frame.original_size ?? "0");
  const sizeMatched = Number(frame.size_matched ?? "0");
  return {
    conditionId: frame.market,
    orderId: frame.id,
    status: frame.status ?? "",
    originalSize: Number.isFinite(originalSize) ? originalSize : 0,
    sizeMatched: Number.isFinite(sizeMatched) ? sizeMatched : 0,
    atMs: Date.now(),
  };
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
        // Polymarket sends epoch seconds as a string for these fields.
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
    asset_id: z.string(),
    side: z.string().optional(),
    size: z.string(),
    price: z.string(),
    fee_rate_bps: z.string(),
    status: z.string().optional(),
    trader_side: z.string().optional(),
    taker_order_id: z.string().optional(),
    match_time: z.string().optional(),
    last_update: z.string().optional(),
  })
  .passthrough();

const orderFrameSchema = z
  .object({
    event_type: z.string().optional(),
    market: z.string(),
    id: z.string(),
    status: z.string().optional(),
    original_size: z.string().optional(),
    size_matched: z.string().optional(),
  })
  .passthrough();

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
}): {
  readonly apiKey: string;
  readonly secret: string;
  readonly passphrase: string;
} {
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
