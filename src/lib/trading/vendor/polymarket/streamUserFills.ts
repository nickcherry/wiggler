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
      onConnect?.();
    });

    ws.addEventListener("message", (event: MessageEvent<string>) => {
      if (!sawFirstFrame) {
        sawFirstFrame = true;
        attempt = 0;
      }
      try {
        handleFrame({ raw: event.data, tokenIdToSide, onFill });
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

function handleFrame({
  raw,
  tokenIdToSide,
  onFill,
}: {
  readonly raw: string;
  readonly tokenIdToSide: ReadonlyMap<string, LeadingSide>;
  readonly onFill: (event: FillEvent) => void;
}): void {
  if (raw.length === 0) {
    return;
  }
  const parsed = JSON.parse(raw);
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of items) {
    const trade = tradeFrameSchema.safeParse(item);
    if (!trade.success) {
      continue;
    }
    const event = mapTradeFrame({ frame: trade.data, tokenIdToSide });
    if (event !== null) {
      onFill(event);
    }
  }
}

function mapTradeFrame({
  frame,
  tokenIdToSide,
}: {
  readonly frame: z.infer<typeof tradeFrameSchema>;
  readonly tokenIdToSide: ReadonlyMap<string, LeadingSide>;
}): FillEvent | null {
  const price = Number(frame.price);
  const size = Number(frame.size);
  const feeRateBps =
    frame.trader_side === "MAKER" ? 0 : Number(frame.fee_rate_bps);
  if (
    !Number.isFinite(price) ||
    !Number.isFinite(size) ||
    !Number.isFinite(feeRateBps)
  ) {
    return null;
  }
  const side = tokenIdToSide.get(frame.asset_id) ?? null;
  if (side === null) {
    return null;
  }
  const atMs = parseAtMs({
    matchTime: frame.match_time,
    lastUpdate: frame.last_update,
  });
  return {
    vendorRef: frame.market,
    outcomeRef: frame.asset_id,
    side,
    price,
    size,
    feeRateBps,
    atMs,
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
    match_time: z.string().optional(),
    last_update: z.string().optional(),
  })
  .passthrough();
