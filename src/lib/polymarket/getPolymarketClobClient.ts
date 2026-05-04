import { env } from "@alea/constants/env";
import { polymarket } from "@alea/constants/polymarket";
import { ClobClient } from "@polymarket/clob-client-v2";
import { Wallet } from "ethers";

/**
 * Lazily-initialized, process-lifetime singleton `ClobClient`.
 *
 * Polymarket API credentials for `(address, nonce=0)` are deterministic and
 * permanent — there is no expiry and no refresh endpoint — so we mint or
 * derive them once at first use, hold the bundle in memory, and never persist
 * it to disk. Signed L2 requests use the local clock for HMAC timestamps to
 * keep the trading hot path free of an extra `/time` round-trip; we measure
 * server↔local drift once at boot and fail fast if it exceeds the threshold
 * below, well before Polymarket would start rejecting signatures.
 *
 * Env-var validation is deferred to first use (not module load) so that
 * unrelated CLI commands which do not touch Polymarket auth still work in
 * environments missing these vars.
 */

/**
 * Polymarket reportedly tolerates ~60s of clock drift before rejecting signed
 * requests. We fail at 30s so a misconfigured host surfaces at startup rather
 * than as 401s during a trade.
 */
const MAX_BOOT_CLOCK_DRIFT_SECONDS = 30;

type AuthState = {
  readonly client: ClobClient;
  readonly apiKey: string;
  readonly funderAddress: string;
  readonly walletAddress: string;
  /**
   * `serverEpochSeconds - localEpochSeconds` measured at boot. Used to
   * fail-fast if the host's clock has drifted far enough that signed L2
   * requests will start being rejected; not consulted on a per-request basis.
   */
  readonly serverTimeOffsetSeconds: number;
};

let memoizedInit: Promise<AuthState> | undefined;

export async function getPolymarketClobClient(): Promise<ClobClient> {
  const state = await getAuthState();
  return state.client;
}

export async function getPolymarketAuthState(): Promise<AuthState> {
  return getAuthState();
}

export async function getPolymarketServerTimeOffset(): Promise<number> {
  const state = await getAuthState();
  return state.serverTimeOffsetSeconds;
}

/**
 * Drops the cached client + creds. The next call to `getPolymarketClobClient`
 * will re-mint the API key bundle. Useful as a recovery hook on hard 401s.
 */
export function resetPolymarketClobClient(): void {
  memoizedInit = undefined;
}

async function getAuthState(): Promise<AuthState> {
  if (!memoizedInit) {
    memoizedInit = initialize().catch((error) => {
      // Don't cache failed initializations — let the next caller retry.
      memoizedInit = undefined;
      throw error;
    });
  }
  return memoizedInit;
}

async function initialize(): Promise<AuthState> {
  const privateKey = requireEnv({
    name: "POLYMARKET_PRIVATE_KEY",
    value: env.polymarketPrivateKey,
  });
  const funderAddress = requireEnv({
    name: "POLYMARKET_FUNDER_ADDRESS",
    value: env.polymarketFunderAddress,
  });

  const wallet = createWallet({ privateKey });

  // Unauthenticated client used only to fetch `/time` and mint or derive the
  // API key bundle. We discard it once we have credentials.
  const bootClient = new ClobClient({
    host: polymarket.clobApiUrl,
    chain: polymarket.chainId,
    signer: wallet,
    signatureType: polymarket.signatureType,
    funderAddress,
  });

  const localBeforeFetchMs = Date.now();
  const serverEpochSeconds = await bootClient.getServerTime();
  const localAfterFetchMs = Date.now();
  const localEpochSeconds = (localBeforeFetchMs + localAfterFetchMs) / 2 / 1000;
  const serverTimeOffsetSeconds = serverEpochSeconds - localEpochSeconds;

  if (Math.abs(serverTimeOffsetSeconds) > MAX_BOOT_CLOCK_DRIFT_SECONDS) {
    throw new Error(
      `Local clock differs from Polymarket's by ${serverTimeOffsetSeconds.toFixed(1)}s ` +
        `(threshold ${MAX_BOOT_CLOCK_DRIFT_SECONDS}s). Polymarket rejects signed ` +
        `requests beyond ~60s of drift; configure NTP on this host.`,
    );
  }

  const creds = await bootClient.createOrDeriveApiKey(polymarket.apiKeyNonce);
  if (!creds.key) {
    throw new Error(
      "Polymarket createOrDeriveApiKey returned an empty key — check that the private key + funder address are valid.",
    );
  }

  const client = new ClobClient({
    host: polymarket.clobApiUrl,
    chain: polymarket.chainId,
    signer: wallet,
    creds,
    signatureType: polymarket.signatureType,
    funderAddress,
  });

  return {
    client,
    apiKey: creds.key,
    funderAddress,
    walletAddress: wallet.address,
    serverTimeOffsetSeconds,
  };
}

function createWallet({ privateKey }: { readonly privateKey: string }): Wallet {
  try {
    return new Wallet(privateKey);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`POLYMARKET_PRIVATE_KEY is malformed: ${cause}`);
  }
}

function requireEnv({
  name,
  value,
}: {
  readonly name: string;
  readonly value: string | undefined;
}): string {
  if (value === undefined) {
    throw new Error(`${name} is not set in the environment.`);
  }
  return value;
}
