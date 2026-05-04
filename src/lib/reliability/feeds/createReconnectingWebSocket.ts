import type { ReliabilitySource } from "@alea/lib/reliability/types";

const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
const DEFAULT_STALE_FRAME_THRESHOLD_MS = 30_000;

export type ReconnectingWebSocketHandle = {
  readonly stop: () => Promise<void>;
};

export function createReconnectingWebSocket({
  source,
  url,
  staleFrameThresholdMs = DEFAULT_STALE_FRAME_THRESHOLD_MS,
  onOpen,
  onMessage,
  onConnect,
  onDisconnect,
  onError,
}: {
  readonly source: ReliabilitySource;
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
      onError?.(new Error(`${source} websocket error`));
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
