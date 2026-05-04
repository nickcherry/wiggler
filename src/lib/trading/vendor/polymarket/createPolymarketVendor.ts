import { getPolymarketAuthState } from "@alea/lib/polymarket/getPolymarketClobClient";
import { cancelPolymarketOrder } from "@alea/lib/trading/vendor/polymarket/cancelOrder";
import { discoverPolymarketMarket } from "@alea/lib/trading/vendor/polymarket/discoverMarket";
import { fetchPolymarketBook } from "@alea/lib/trading/vendor/polymarket/fetchBook";
import { hydratePolymarketMarketState } from "@alea/lib/trading/vendor/polymarket/hydrateMarketState";
import type { PolymarketOrderConstraints } from "@alea/lib/trading/vendor/polymarket/marketConstraints";
import { placePolymarketMakerLimitBuy } from "@alea/lib/trading/vendor/polymarket/placeMakerLimitBuy";
import { scanPolymarketLifetimePnl } from "@alea/lib/trading/vendor/polymarket/scanLifetimePnl";
import { streamPolymarketUserFills } from "@alea/lib/trading/vendor/polymarket/streamUserFills";
import type { Vendor } from "@alea/lib/trading/vendor/types";
import type { ClobClient } from "@polymarket/clob-client-v2";

export type CreatePolymarketVendorOptions = {
  /**
   * If `true`, the factory tries to mint the L2 API key bundle eagerly
   * so `walletAddress` is populated synchronously and order writes
   * fail fast on missing env vars. The live runner sets this; the dry-
   * run runner leaves it false so it can run without credentials.
   */
  readonly eagerAuth?: boolean;
};

/**
 * Constructs the Polymarket-flavoured `Vendor`.
 *
 * **Auth is lazy by default** — the factory only mints the L2 API
 * key bundle when an authenticated method (`placeMakerLimitBuy`,
 * `cancelOrder`, `streamUserFills`, `hydrateMarketState`,
 * `scanLifetimePnl`) is first invoked. The dry-run runner can
 * construct a vendor without any wallet env set; only the live runner,
 * which calls those methods, requires the full credential set. Pass
 * `eagerAuth: true` to fail fast at construction when running the
 * live trader.
 *
 * `constraintsByConditionId` is the only piece of vendor-internal state
 * the implementation maintains beyond the auth bundle: it caches the
 * venue-provided tick, size, fee, age, and neg-risk parameters returned
 * by market discovery and book hydration so `placeMakerLimitBuy` never
 * falls back to hardcoded venue assumptions.
 */
export async function createPolymarketVendor(
  options: CreatePolymarketVendorOptions = {},
): Promise<Vendor> {
  const constraintsByConditionId = new Map<
    string,
    PolymarketOrderConstraints
  >();
  let cachedAuth: { client: ClobClient; walletAddress: string } | null = null;

  const auth = async (): Promise<{
    client: ClobClient;
    walletAddress: string;
  }> => {
    if (cachedAuth !== null) {
      return cachedAuth;
    }
    const state = await getPolymarketAuthState();
    cachedAuth = {
      client: state.client,
      walletAddress: state.walletAddress,
    };
    return cachedAuth;
  };

  if (options.eagerAuth === true) {
    await auth();
  }

  const walletAddress = (): string => {
    if (cachedAuth !== null) {
      return cachedAuth.walletAddress;
    }
    // Lazy callers that read `walletAddress` before any auth method
    // has been invoked get an empty string. No live-trading code
    // path reads it without first invoking auth.
    return "";
  };

  return {
    id: "polymarket",
    get walletAddress() {
      return walletAddress();
    },

    async discoverMarket({ asset, windowStartUnixSeconds, signal }) {
      const result = await discoverPolymarketMarket({
        asset,
        windowStartUnixSeconds,
        signal,
      });
      if (result === null) {
        return null;
      }
      if (result.market.constraints !== undefined) {
        constraintsByConditionId.set(
          result.market.vendorRef,
          result.market.constraints as PolymarketOrderConstraints,
        );
      }
      return result.market;
    },

    async fetchBook({ market, signal }) {
      const book = await fetchPolymarketBook({ market, signal });
      if (book.market.constraints !== undefined) {
        constraintsByConditionId.set(
          book.market.vendorRef,
          book.market.constraints as PolymarketOrderConstraints,
        );
      }
      return book;
    },

    async placeMakerLimitBuy({
      market,
      side,
      limitPrice,
      stakeUsd,
      expireBeforeMs,
    }) {
      const { client } = await auth();
      const constraints =
        constraintsByConditionId.get(market.vendorRef) ??
        (market.constraints as PolymarketOrderConstraints | undefined);
      if (constraints === undefined) {
        throw new Error(
          `Polymarket constraints missing for ${market.vendorRef}; refusing to place an order without venue tick/min-size parameters.`,
        );
      }
      return placePolymarketMakerLimitBuy({
        client,
        market,
        side,
        limitPrice,
        stakeUsd,
        expireBeforeMs,
        constraints,
      });
    },

    async cancelOrder({ orderId }) {
      const { client } = await auth();
      return cancelPolymarketOrder({ client, orderId });
    },

    streamUserFills(input) {
      // streamUserFills consults `getPolymarketAuthState` itself on
      // every (re)connect, so it doesn't need our cached client —
      // the dry-run never calls this anyway.
      return streamPolymarketUserFills(input);
    },

    async hydrateMarketState({ market }) {
      const { client } = await auth();
      return hydratePolymarketMarketState({ client, market });
    },

    async scanLifetimePnl({ onProgress }) {
      const { client } = await auth();
      return scanPolymarketLifetimePnl({ client, onProgress });
    },
  };
}
