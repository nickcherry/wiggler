import { polymarket } from "@alea/constants/polymarket";
import { getPolymarketAuthState } from "@alea/lib/polymarket/getPolymarketClobClient";

type ProbeResult = {
  readonly opened: boolean;
  readonly subscribedAtMs: number;
  readonly closedCleanly: boolean;
  readonly framesReceived: number;
  readonly errorMessage: string | undefined;
};

/**
 * Opens a WebSocket to the CLOB `/ws/user` channel, sends an L2-authenticated
 * subscribe frame, observes for `observeMs` milliseconds (or until the server
 * closes), then closes the socket and returns a small result summary. No
 * filters on `markets: []` means "subscribe to all this user's events".
 *
 * This is a smoke-test helper used by the auth-check command — not a long-
 * lived stream consumer. Stream consumers should be built separately with
 * proper reconnect and backpressure.
 */
export async function probeUserWebSocket({
  observeMs,
}: {
  readonly observeMs: number;
}): Promise<ProbeResult> {
  const auth = await getPolymarketAuthState();
  const credsForFrame = extractCredsFromClient(auth.client);

  return new Promise<ProbeResult>((resolve) => {
    const ws = new WebSocket(polymarket.userWsUrl);
    let opened = false;
    let subscribedAtMs = 0;
    let closedCleanly = false;
    let framesReceived = 0;
    let errorMessage: string | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (): void => {
      if (closeTimer !== undefined) {
        clearTimeout(closeTimer);
        closeTimer = undefined;
      }
      try {
        ws.close();
      } catch {
        // ignore — already closed
      }
      resolve({
        opened,
        subscribedAtMs,
        closedCleanly,
        framesReceived,
        errorMessage,
      });
    };

    ws.addEventListener("open", () => {
      opened = true;
      subscribedAtMs = Date.now();
      ws.send(
        JSON.stringify({
          auth: {
            apiKey: credsForFrame.apiKey,
            secret: credsForFrame.secret,
            passphrase: credsForFrame.passphrase,
          },
          type: "user",
          markets: [],
        }),
      );
      closeTimer = setTimeout(() => {
        closedCleanly = true;
        settle();
      }, observeMs);
    });

    ws.addEventListener("message", () => {
      framesReceived += 1;
    });

    ws.addEventListener("error", () => {
      errorMessage = "websocket error event";
      settle();
    });

    ws.addEventListener("close", (event: CloseEvent) => {
      // If we hit close before the timer fires, treat it as clean only when
      // the server explicitly returned 1000.
      if (closeTimer === undefined) {
        return;
      }
      if (event.code === 1000) {
        closedCleanly = true;
      } else {
        errorMessage = `socket closed with code ${event.code}: ${event.reason || "<no reason>"}`;
      }
      settle();
    });
  });
}

function extractCredsFromClient(client: {
  readonly creds?: {
    apiKey?: string;
    key?: string;
    secret: string;
    passphrase: string;
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
  // The SDK's `ApiKeyCreds` type stores the API key under `key`, but the
  // websocket frame expects `apiKey`. Accept either, prefer `key`.
  const apiKey = creds.key ?? creds.apiKey;
  if (!apiKey) {
    throw new Error("Polymarket client credentials are missing apiKey.");
  }
  return { apiKey, secret: creds.secret, passphrase: creds.passphrase };
}
