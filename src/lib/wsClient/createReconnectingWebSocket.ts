/**
 * Reconnect schedule. Each entry is the delay before the next
 * connect attempt; the final entry is reused indefinitely so a
 * persistently-down feed keeps retrying instead of giving up.
 */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

const DEFAULT_STALE_FRAME_THRESHOLD_MS = 30_000;

export type ReconnectingWebSocketHandle = {
  readonly stop: () => Promise<void>;
};

/**
 * Generic, source-agnostic auto-reconnecting WebSocket client.
 *
 * Three guarantees beyond the raw browser `WebSocket`:
 *   1. **Auto-reconnect** with exponential-style backoff. The
 *      attempt counter resets after the first frame of each
 *      successful connection so a brief blip doesn't permanently
 *      saturate the schedule.
 *   2. **Stale-frame watchdog** forces a reconnect when no message
 *      has arrived for `staleFrameThresholdMs`. Some venue libs
 *      leave a closed socket in a half-open state without firing a
 *      `close`; the watchdog catches those.
 *   3. **`onConnect` per cycle.** Fires on every successful connect,
 *      including after a reconnect. Callers that need to (re-)send
 *      a subscription frame should do it from `onOpen`. The label
 *      separation between `onOpen` (raw socket open, synchronous)
 *      and `onConnect` (semantically connected) lets venues that
 *      need to send a subscribe-and-await-ack handshake hook into
 *      both events.
 *
 * Note: the helper does NOT enforce any specific subscribe protocol.
 * Subscribe payloads are the caller's responsibility — pass a
 * function via `onOpen` that sends them.
 *
 * `label` is used in error messages and disconnect reasons; pick
 * something operator-friendly like `"binance-perp"` or
 * `"coinbase-spot-level2"`.
 */
export function createReconnectingWebSocket({
  label,
  url,
  staleFrameThresholdMs = DEFAULT_STALE_FRAME_THRESHOLD_MS,
  onOpen,
  onMessage,
  onConnect,
  onDisconnect,
  onError,
}: {
  readonly label: string;
  readonly url: string;
  readonly staleFrameThresholdMs?: number;
  readonly onOpen?: (ws: WebSocket) => void;
  readonly onMessage: (raw: string) => void;
  readonly onConnect?: () => void;
  readonly onDisconnect?: (reason: string) => void;
  readonly onError?: (error: Error) => void;
}): ReconnectingWebSocketHandle {
  let stopped = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let lastFrameAtMs = 0;
  let attempt = 0;

  const clearReconnectTimer = (): void => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const clearWatchdog = (): void => {
    if (watchdog !== null) {
      clearInterval(watchdog);
      watchdog = null;
    }
  };

  const scheduleReconnect = (reason: string): void => {
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
      connect();
    }, delay);
  };

  const connect = (): void => {
    if (stopped) {
      return;
    }
    clearWatchdog();
    const ws = new WebSocket(url);
    socket = ws;
    let sawFirstFrame = false;

    ws.addEventListener("open", () => {
      onOpen?.(ws);
      onConnect?.();
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        return;
      }
      lastFrameAtMs = Date.now();
      if (!sawFirstFrame) {
        sawFirstFrame = true;
        attempt = 0;
      }
      try {
        onMessage(event.data);
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    });

    ws.addEventListener("error", () => {
      onError?.(new Error(`${label} websocket error`));
    });

    ws.addEventListener("close", (event: CloseEvent) => {
      socket = null;
      clearWatchdog();
      if (stopped) {
        return;
      }
      scheduleReconnect(
        event.reason.length > 0
          ? `socket closed: ${event.reason}`
          : `socket closed (code ${event.code})`,
      );
    });

    lastFrameAtMs = Date.now();
    watchdog = setInterval(() => {
      if (Date.now() - lastFrameAtMs <= staleFrameThresholdMs) {
        return;
      }
      clearWatchdog();
      try {
        ws.close(4000, "stale-frame watchdog");
      } catch {
        scheduleReconnect("stale-frame watchdog");
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
          // caller is shutting down
        }
      }
    },
  };
}
