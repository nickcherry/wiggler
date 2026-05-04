import type { LeadingSide } from "@alea/lib/trading/types";
import type { Asset } from "@alea/types/assets";

/**
 * Vendor-agnostic interface to a prediction-market venue. Concrete
 * implementations (Polymarket today; Kalshi / Hyperliquid plausible
 * tomorrow) live one-directory-per-vendor under
 * `src/lib/trading/vendor/<id>/`. The live runner and the dry-run
 * runner depend on this interface and nothing else from the vendor
 * world; switching vendors is intended to be a new directory plus
 * one-line factory swap, not a runner rewrite.
 *
 * The interface is deliberately narrow — only operations the runner
 * actually needs. Vendor-specific niceties (Polymarket's neg-risk
 * flag, Kalshi's series ids, etc.) stay encapsulated in the
 * implementation.
 */

/**
 * One "up/down 5m" market the bot can trade. The runner reads
 * `vendorRef`, `upRef`, and `downRef` as opaque strings — they're
 * fine to embed venue-native ids (Polymarket conditionId + clob
 * tokenIds; Kalshi market_ticker + outcome side). The runner uses
 * them only as inputs to other Vendor methods and as log-line
 * fragments.
 */
export type TradableMarket = {
  readonly asset: Asset;
  readonly windowStartUnixSeconds: number;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly vendorRef: string;
  readonly upRef: string;
  readonly downRef: string;
  readonly acceptingOrders: boolean;
  /**
   * Venue-provided trading constraints for this market, when the
   * adapter has hydrated them. The live runner treats missing
   * constraints as "do not place" for real venues; tests and dry-run
   * fakes may omit them when no order will be posted.
   */
  readonly constraints?: MarketOrderConstraints;
  /**
   * Optional human-friendly identifier (Polymarket slug, Kalshi
   * ticker, etc.) for log lines. Never used as an API input.
   */
  readonly displayLabel?: string;
};

export type MarketOrderConstraints = {
  /** Minimum valid price increment, e.g. 0.01 or 0.001. */
  readonly priceTickSize: number;
  /** Minimum order size in shares/contracts. */
  readonly minOrderSize: number;
  /** Minimum age in seconds before a resting order can be cancelled. */
  readonly minimumOrderAgeSeconds: number;
  readonly makerBaseFeeBps: number | null;
  readonly takerBaseFeeBps: number | null;
  readonly feesTakerOnly: boolean | null;
};

export type TopOfBook = {
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly bidLevels?: readonly PriceLevel[];
  readonly askLevels?: readonly PriceLevel[];
};

export type PriceLevel = {
  readonly price: number;
  readonly size: number;
};

export type UpDownBook = {
  readonly market: TradableMarket;
  readonly up: TopOfBook;
  readonly down: TopOfBook;
  readonly fetchedAtMs: number;
};

export type PreparedMakerLimitOrder = {
  readonly side: LeadingSide;
  readonly outcomeRef: string;
  readonly limitPrice: number;
  readonly sharesIfFilled: number;
  readonly feeRateBps: number;
  readonly orderType: "GTC" | "GTD";
  readonly expiresAtMs: number | null;
  readonly preparedAtMs: number;
};

export type PlacedOrder = {
  readonly orderId: string;
  readonly side: LeadingSide;
  readonly outcomeRef: string;
  readonly limitPrice: number;
  readonly sharesIfFilled: number;
  readonly feeRateBps: number;
  readonly orderType: "GTC" | "GTD";
  readonly expiresAtMs: number | null;
  readonly placedAtMs: number;
};

export type CancelResult = {
  readonly accepted: boolean;
  /**
   * True when the venue says the order is no longer live even if the
   * cancel request itself was not accepted (for example, already filled
   * or already cancelled). False for network/client failures where the
   * order may still be resting and should remain tracked locally.
   */
  readonly terminal: boolean;
  readonly errorMessage: string | null;
};

/**
 * Thrown by `placeMakerLimitBuy` when the venue rejects the order
 * because it would have crossed the spread (= would have been filled
 * as taker). The runner treats this as the *expected* friction of
 * being a maker — silent on Telegram, counted in the per-window
 * summary, re-evaluated against the moved book, retried.
 *
 * The vendor implementation is responsible for translating its
 * native error response into this typed throw. Anything else is
 * treated as a generic error by the runner.
 */
export class PostOnlyRejectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostOnlyRejectionError";
  }
}

export type FillEvent = {
  readonly vendorRef: string;
  readonly outcomeRef: string;
  readonly side: LeadingSide;
  readonly price: number;
  readonly size: number;
  readonly feeRateBps: number;
  readonly atMs: number;
};

export type UserStreamHandle = {
  readonly stop: () => Promise<void>;
};

export type MarketDataStreamHandle = {
  readonly stop: () => Promise<void>;
};

export type MarketDataTradeEvent = {
  readonly kind: "trade";
  readonly vendorRef: string | null;
  readonly outcomeRef: string;
  readonly price: number;
  readonly size: number | null;
  readonly side: "BUY" | "SELL" | null;
  readonly atMs: number;
};

export type MarketDataBookEvent = {
  readonly kind: "book";
  readonly vendorRef: string | null;
  readonly outcomeRef: string;
  readonly bids: readonly PriceLevel[];
  readonly asks: readonly PriceLevel[];
  readonly atMs: number;
};

export type MarketDataBestBidAskEvent = {
  readonly kind: "best-bid-ask";
  readonly vendorRef: string | null;
  readonly outcomeRef: string;
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly atMs: number;
};

export type MarketDataPriceChangeEvent = {
  readonly kind: "price-change";
  readonly vendorRef: string | null;
  readonly outcomeRef: string;
  readonly price: number;
  readonly side: "BUY" | "SELL" | null;
  readonly size: number | null;
  readonly atMs: number;
};

export type MarketDataTickSizeChangeEvent = {
  readonly kind: "tick-size-change";
  readonly vendorRef: string | null;
  readonly outcomeRef: string | null;
  readonly oldTickSize: number | null;
  readonly newTickSize: number;
  readonly atMs: number;
};

export type MarketDataResolvedEvent = {
  readonly kind: "resolved";
  readonly vendorRef: string;
  readonly winningOutcomeRef: string | null;
  readonly winningSide: LeadingSide | null;
  readonly atMs: number;
};

export type MarketDataEvent =
  | MarketDataTradeEvent
  | MarketDataBookEvent
  | MarketDataBestBidAskEvent
  | MarketDataPriceChangeEvent
  | MarketDataTickSizeChangeEvent
  | MarketDataResolvedEvent;

export type MarketDataStreamCallbacks = {
  readonly onEvent: (event: MarketDataEvent) => void;
  readonly onConnect?: () => void;
  readonly onDisconnect?: (reason: string) => void;
  readonly onError?: (error: Error) => void;
};

export type UserStreamCallbacks = {
  readonly onFill: (event: FillEvent) => void;
  readonly onConnect?: () => void;
  readonly onDisconnect?: (reason: string) => void;
  readonly onError?: (error: Error) => void;
};

/**
 * Per-market hydration result. The runner calls `hydrateMarketState`
 * on every market discovery so a process restart picks up any open
 * order or partial-fill the venue has on file for our wallet.
 */
export type MarketHydration = {
  readonly openOrder: PlacedOrder | null;
  readonly side: LeadingSide | null;
  readonly outcomeRef: string | null;
  readonly sharesFilled: number;
  readonly costUsd: number;
  readonly feesUsd: number;
  readonly feeRateBpsAvg: number;
};

export type MarketOutcome =
  | {
      readonly status: "pending";
      readonly market: TradableMarket;
      readonly checkedAtMs: number;
      readonly reason: string | null;
    }
  | {
      readonly status: "resolved";
      readonly market: TradableMarket;
      readonly winningSide: LeadingSide;
      readonly winningOutcomeRef: string;
      readonly resolvedAtMs: number;
    };

export type LifetimePnlScanProgress =
  | { readonly kind: "trades-page"; readonly tradesSoFar: number }
  | {
      readonly kind: "markets-progress";
      readonly resolved: number;
      readonly total: number;
    };

export type LifetimePnlScanResult = {
  readonly lifetimePnlUsd: number;
  readonly resolvedMarketsCounted: number;
  readonly unresolvedMarketsSkipped: number;
  readonly tradesCounted: number;
};

/**
 * The bundle of operations the runner needs from a vendor. Construct
 * one via the per-vendor factory (e.g. `createPolymarketVendor`).
 *
 * Reads (`discoverMarket`, `fetchBook`, `hydrateMarketState`,
 * `scanLifetimePnl`) are unauthenticated where possible; writes
 * (`placeMakerLimitBuy`, `cancelOrder`, `streamUserFills`) take care
 * of their own auth via the factory's bound state.
 */
export type Vendor = {
  /** Stable identifier — used in log lines and the lifetime-PnL store. */
  readonly id: string;

  /** The wallet/account address the vendor is bound to. */
  readonly walletAddress: string;

  discoverMarket(input: {
    readonly asset: Asset;
    readonly windowStartUnixSeconds: number;
    readonly signal?: AbortSignal;
  }): Promise<TradableMarket | null>;

  fetchBook(input: {
    readonly market: TradableMarket;
    readonly signal?: AbortSignal;
  }): Promise<UpDownBook>;

  prepareMakerLimitBuy?(input: {
    readonly market: TradableMarket;
    readonly side: LeadingSide;
    readonly limitPrice: number;
    readonly stakeUsd: number;
    readonly expireBeforeMs: number;
  }): Promise<PreparedMakerLimitOrder>;

  placeMakerLimitBuy(input: {
    readonly market: TradableMarket;
    readonly side: LeadingSide;
    readonly limitPrice: number;
    readonly stakeUsd: number;
    readonly expireBeforeMs: number;
  }): Promise<PlacedOrder>;

  cancelOrder(input: { readonly orderId: string }): Promise<CancelResult>;

  streamUserFills(
    input: {
      readonly markets: readonly TradableMarket[];
    } & UserStreamCallbacks,
  ): UserStreamHandle;

  streamMarketData?(
    input: {
      readonly markets: readonly TradableMarket[];
    } & MarketDataStreamCallbacks,
  ): MarketDataStreamHandle;

  hydrateMarketState(input: {
    readonly market: TradableMarket;
  }): Promise<MarketHydration>;

  resolveMarketOutcome?(input: {
    readonly market: TradableMarket;
    readonly signal?: AbortSignal;
  }): Promise<MarketOutcome>;

  scanLifetimePnl(input: {
    readonly onProgress?: (event: LifetimePnlScanProgress) => void;
  }): Promise<LifetimePnlScanResult>;
};
