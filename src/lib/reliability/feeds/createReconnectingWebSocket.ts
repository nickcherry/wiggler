import type { ReliabilitySource } from "@alea/lib/reliability/types";
import {
  createReconnectingWebSocket as createSharedReconnectingWebSocket,
  type ReconnectingWebSocketHandle as SharedReconnectingWebSocketHandle,
} from "@alea/lib/wsClient/createReconnectingWebSocket";

export type ReconnectingWebSocketHandle = SharedReconnectingWebSocketHandle;

/**
 * Reliability-shaped wrapper around the shared reconnecting WS
 * helper. Kept as a thin layer so the reliability codebase keeps its
 * type-safe `source: ReliabilitySource` parameter; the underlying
 * connection logic is owned by `lib/wsClient/`.
 */
export function createReconnectingWebSocket({
  source,
  ...rest
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
  return createSharedReconnectingWebSocket({ label: source, ...rest });
}
