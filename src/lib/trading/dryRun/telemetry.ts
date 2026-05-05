import type { LivePriceTick } from "@alea/lib/livePrices/types";
import type { LeadingSide } from "@alea/lib/trading/types";
import type {
  MarketDataTradeEvent,
  PriceLevel,
  UpDownBook,
} from "@alea/lib/trading/vendor/types";
import type { Asset } from "@alea/types/assets";

const PRICE_EPSILON = 1e-9;
const PRICE_HISTORY_MAX_AGE_MS = 120_000;
const MARKET_TRADE_HISTORY_MAX_AGE_MS = 330_000;
const SHARE_QUANTUM = 100;

const PRICE_LOOKBACKS_MS = [1_000, 5_000, 15_000, 30_000, 60_000] as const;
const MARKET_TRADE_LOOKBACKS_MS = [15_000, 30_000, 60_000] as const;
const LEAD_TIME_OFFSETS_MS = [1_000, 5_000, 10_000, 20_000, 30_000] as const;

export type DryPriceHistory = Map<Asset, LivePriceTick[]>;
export type DryMarketTradeHistory = Map<string, MarketDataTradeEvent[]>;

export type DryEntryPriceTelemetry = {
  readonly tickReceivedAtMs: number;
  readonly tickExchangeTimeMs: number | null;
  readonly tickAgeMs: number;
  readonly exchangeAgeMs: number | null;
  readonly bid: number;
  readonly ask: number;
  readonly mid: number;
  readonly side: LeadingSide;
  readonly signedDistanceBp: number;
  readonly lookbacks: readonly DryEntryPriceLookback[];
};

export type DryEntryPriceLookback = {
  readonly lookbackMs: number;
  readonly tickReceivedAtMs: number;
  readonly tickExchangeTimeMs: number | null;
  readonly tickAgeMs: number;
  readonly mid: number;
  readonly side: LeadingSide;
  readonly signedDistanceBp: number;
  readonly delta: number;
  readonly deltaBp: number;
};

export type DryEntryBookTelemetry = {
  readonly fetchedAtMs: number;
  readonly ageMs: number;
  readonly chosenSide: LeadingSide;
  readonly chosenBestBid: number | null;
  readonly chosenBestAsk: number | null;
  readonly chosenSpread: number | null;
  readonly queueAheadShares: number | null;
  readonly chosenBidSizeAtLimit: number | null;
  readonly chosenAskSizeAtBestAsk: number | null;
  readonly oppositeBestBid: number | null;
  readonly oppositeBestAsk: number | null;
  readonly oppositeSpread: number | null;
  readonly priceTickSize: number | null;
  readonly minOrderSize: number | null;
  readonly makerBaseFeeBps: number | null;
  readonly takerBaseFeeBps: number | null;
  readonly feesTakerOnly: boolean | null;
};

export type DryPreEntryMarketTelemetry = {
  readonly tradeCountSeen: number;
  readonly firstTradeAtMs: number | null;
  readonly lastTradeAtMs: number | null;
  readonly lastTradeAgeMs: number | null;
  readonly lastPrice: number | null;
  readonly lookbacks: readonly DryPreEntryMarketLookback[];
};

export type DryPreEntryMarketLookback = {
  readonly lookbackMs: number;
  readonly tradeCount: number;
  readonly knownSizeTradeCount: number;
  readonly totalKnownSize: number;
  readonly firstTradeAtMs: number | null;
  readonly lastTradeAtMs: number | null;
  readonly lastTradeAgeMs: number | null;
  readonly firstPrice: number | null;
  readonly lastPrice: number | null;
  readonly minPrice: number | null;
  readonly maxPrice: number | null;
  readonly priceDelta: number | null;
  readonly atOrBelowLimitTradeCount: number;
  readonly belowLimitTradeCount: number;
};

export type DryTakerCounterfactual = {
  readonly askPrice: number;
  readonly sharesIfFilled: number;
  readonly costUsd: number;
  readonly estimatedFeeRateBps: number | null;
  readonly estimatedFeeUsd: number | null;
};

export type DryLeadTimeCounterfactual = {
  readonly leadMs: number;
  readonly hypotheticalPlacedAtMs: number;
  readonly tradeSamples: number;
  readonly firstTouchAtMs: number | null;
  readonly firstTouchLatencyMs: number | null;
  readonly touchedBeforeActualPlacement: boolean;
  readonly firstCrossAtMs: number | null;
  readonly firstCrossLatencyMs: number | null;
  readonly crossedBeforeActualPlacement: boolean;
};

export function appendPriceTick({
  history,
  tick,
}: {
  readonly history: DryPriceHistory;
  readonly tick: LivePriceTick;
}): void {
  const ticks = history.get(tick.asset) ?? [];
  ticks.push(tick);
  const minReceivedAtMs = tick.receivedAtMs - PRICE_HISTORY_MAX_AGE_MS;
  while (
    ticks.length > 0 &&
    (ticks[0]?.receivedAtMs ?? Number.POSITIVE_INFINITY) < minReceivedAtMs
  ) {
    ticks.shift();
  }
  history.set(tick.asset, ticks);
}

export function appendMarketTrade({
  history,
  trade,
  nowMs,
}: {
  readonly history: DryMarketTradeHistory;
  readonly trade: MarketDataTradeEvent;
  readonly nowMs: number;
}): void {
  const trades = history.get(trade.outcomeRef) ?? [];
  trades.push(trade);
  const minAtMs = nowMs - MARKET_TRADE_HISTORY_MAX_AGE_MS;
  while (
    trades.length > 0 &&
    (trades[0]?.atMs ?? Number.POSITIVE_INFINITY) < minAtMs
  ) {
    trades.shift();
  }
  history.set(trade.outcomeRef, trades);
}

export function buildEntryPriceTelemetry({
  ticks,
  placedAtMs,
  line,
}: {
  readonly ticks: readonly LivePriceTick[];
  readonly placedAtMs: number;
  readonly line: number;
}): DryEntryPriceTelemetry | null {
  const current = tickAtOrBefore({ ticks, atMs: placedAtMs });
  if (current === null) {
    return null;
  }
  return {
    tickReceivedAtMs: current.receivedAtMs,
    tickExchangeTimeMs: current.exchangeTimeMs,
    tickAgeMs: Math.max(0, placedAtMs - current.receivedAtMs),
    exchangeAgeMs:
      current.exchangeTimeMs === null
        ? null
        : Math.max(0, placedAtMs - current.exchangeTimeMs),
    bid: current.bid,
    ask: current.ask,
    mid: current.mid,
    side: sideForPrice({ price: current.mid, line }),
    signedDistanceBp: signedDistanceBp({ price: current.mid, line }),
    lookbacks: PRICE_LOOKBACKS_MS.flatMap((lookbackMs) => {
      const previous = tickAtOrBefore({
        ticks,
        atMs: placedAtMs - lookbackMs,
      });
      if (previous === null) {
        return [];
      }
      return [
        {
          lookbackMs,
          tickReceivedAtMs: previous.receivedAtMs,
          tickExchangeTimeMs: previous.exchangeTimeMs,
          tickAgeMs: Math.max(0, placedAtMs - previous.receivedAtMs),
          mid: previous.mid,
          side: sideForPrice({ price: previous.mid, line }),
          signedDistanceBp: signedDistanceBp({ price: previous.mid, line }),
          delta: current.mid - previous.mid,
          deltaBp: ((current.mid - previous.mid) / line) * 10_000,
        },
      ];
    }),
  };
}

export function buildEntryBookTelemetry({
  book,
  side,
  limitPrice,
  queueAheadShares,
  placedAtMs,
}: {
  readonly book: UpDownBook;
  readonly side: LeadingSide;
  readonly limitPrice: number;
  readonly queueAheadShares: number | null;
  readonly placedAtMs: number;
}): DryEntryBookTelemetry {
  const chosen = topForSide({ book, side });
  const opposite = topForSide({ book, side: side === "up" ? "down" : "up" });
  const constraints = book.market.constraints;
  return {
    fetchedAtMs: book.fetchedAtMs,
    ageMs: Math.max(0, placedAtMs - book.fetchedAtMs),
    chosenSide: side,
    chosenBestBid: chosen.bestBid,
    chosenBestAsk: chosen.bestAsk,
    chosenSpread: spreadForTop({ top: chosen }),
    queueAheadShares,
    chosenBidSizeAtLimit: sizeAtPrice({
      levels: chosen.bidLevels,
      price: limitPrice,
    }),
    chosenAskSizeAtBestAsk:
      chosen.bestAsk === null
        ? null
        : sizeAtPrice({ levels: chosen.askLevels, price: chosen.bestAsk }),
    oppositeBestBid: opposite.bestBid,
    oppositeBestAsk: opposite.bestAsk,
    oppositeSpread: spreadForTop({ top: opposite }),
    priceTickSize: constraints?.priceTickSize ?? null,
    minOrderSize: constraints?.minOrderSize ?? null,
    makerBaseFeeBps: constraints?.makerBaseFeeBps ?? null,
    takerBaseFeeBps: constraints?.takerBaseFeeBps ?? null,
    feesTakerOnly: constraints?.feesTakerOnly ?? null,
  };
}

export function buildPreEntryMarketTelemetry({
  trades,
  placedAtMs,
  limitPrice,
}: {
  readonly trades: readonly MarketDataTradeEvent[];
  readonly placedAtMs: number;
  readonly limitPrice: number;
}): DryPreEntryMarketTelemetry {
  const preEntry = trades
    .filter((trade) => trade.atMs < placedAtMs)
    .sort((a, b) => a.atMs - b.atMs);
  const first = preEntry[0] ?? null;
  const last = preEntry[preEntry.length - 1] ?? null;
  return {
    tradeCountSeen: preEntry.length,
    firstTradeAtMs: first?.atMs ?? null,
    lastTradeAtMs: last?.atMs ?? null,
    lastTradeAgeMs: last === null ? null : Math.max(0, placedAtMs - last.atMs),
    lastPrice: last?.price ?? null,
    lookbacks: MARKET_TRADE_LOOKBACKS_MS.map((lookbackMs) =>
      marketLookbackStats({
        trades: preEntry.filter(
          (trade) => trade.atMs >= placedAtMs - lookbackMs,
        ),
        placedAtMs,
        limitPrice,
        lookbackMs,
      }),
    ),
  };
}

/**
 * Pre-entry chosen-outcome price drift over a single lookback window,
 * used by the adverse-momentum gate. Returns `lastPrice − firstPrice`
 * for trades on the chosen outcome strictly before placement and
 * within `lookbackMs` of `placedAtMs`. `null` when there are fewer
 * than two trades in the window — the gate treats `null` as "no
 * signal, allow the trade" so a quiet period doesn't block placement.
 *
 * Decoupled from `buildPreEntryMarketTelemetry` so the gate can be
 * computed in O(window) at decision time without materializing all
 * three lookbacks. The richer telemetry is still emitted with the
 * placed order for post-hoc analysis.
 */
export function computePreEntryPriceDelta({
  trades,
  placedAtMs,
  lookbackMs,
}: {
  readonly trades: readonly MarketDataTradeEvent[];
  readonly placedAtMs: number;
  readonly lookbackMs: number;
}): number | null {
  const windowStart = placedAtMs - lookbackMs;
  let firstPrice: number | null = null;
  let firstAt = Number.POSITIVE_INFINITY;
  let lastPrice: number | null = null;
  let lastAt = Number.NEGATIVE_INFINITY;
  for (const trade of trades) {
    if (trade.atMs >= placedAtMs || trade.atMs < windowStart) {
      continue;
    }
    if (trade.atMs < firstAt) {
      firstAt = trade.atMs;
      firstPrice = trade.price;
    }
    if (trade.atMs > lastAt) {
      lastAt = trade.atMs;
      lastPrice = trade.price;
    }
  }
  if (firstPrice === null || lastPrice === null) {
    return null;
  }
  return lastPrice - firstPrice;
}

export function buildTakerCounterfactual({
  book,
  side,
  stakeUsd,
}: {
  readonly book: UpDownBook;
  readonly side: LeadingSide;
  readonly stakeUsd: number;
}): DryTakerCounterfactual | null {
  const askPrice = topForSide({ book, side }).bestAsk;
  if (askPrice === null || askPrice <= 0 || askPrice >= 1) {
    return null;
  }
  const sharesIfFilled =
    Math.floor((stakeUsd / askPrice) * SHARE_QUANTUM) / SHARE_QUANTUM;
  if (sharesIfFilled <= 0) {
    return null;
  }
  const estimatedFeeRateBps = book.market.constraints?.takerBaseFeeBps ?? null;
  const estimatedFeeUsd =
    estimatedFeeRateBps === null
      ? null
      : estimatePolymarketFeeUsd({
          shares: sharesIfFilled,
          price: askPrice,
          feeRateBps: estimatedFeeRateBps,
        });
  return {
    askPrice,
    sharesIfFilled,
    costUsd: sharesIfFilled * askPrice,
    estimatedFeeRateBps,
    estimatedFeeUsd,
  };
}

export function buildLeadTimeCounterfactuals({
  trades,
  order,
}: {
  readonly trades: readonly MarketDataTradeEvent[];
  readonly order: {
    readonly placedAtMs: number;
    readonly expiresAtMs: number;
    readonly limitPrice: number;
  };
}): DryLeadTimeCounterfactual[] {
  return LEAD_TIME_OFFSETS_MS.map((leadMs) => {
    const hypotheticalPlacedAtMs = Math.max(0, order.placedAtMs - leadMs);
    const samples = trades
      .filter(
        (trade) =>
          trade.atMs >= hypotheticalPlacedAtMs &&
          trade.atMs <= order.expiresAtMs,
      )
      .sort((a, b) => a.atMs - b.atMs);
    const firstTouch =
      samples.find(
        (trade) => trade.price <= order.limitPrice + PRICE_EPSILON,
      ) ?? null;
    const firstCross =
      samples.find((trade) => trade.price < order.limitPrice - PRICE_EPSILON) ??
      null;
    return {
      leadMs,
      hypotheticalPlacedAtMs,
      tradeSamples: samples.length,
      firstTouchAtMs: firstTouch?.atMs ?? null,
      firstTouchLatencyMs:
        firstTouch === null ? null : firstTouch.atMs - hypotheticalPlacedAtMs,
      touchedBeforeActualPlacement:
        firstTouch !== null && firstTouch.atMs < order.placedAtMs,
      firstCrossAtMs: firstCross?.atMs ?? null,
      firstCrossLatencyMs:
        firstCross === null ? null : firstCross.atMs - hypotheticalPlacedAtMs,
      crossedBeforeActualPlacement:
        firstCross !== null && firstCross.atMs < order.placedAtMs,
    };
  });
}

function tickAtOrBefore({
  ticks,
  atMs,
}: {
  readonly ticks: readonly LivePriceTick[];
  readonly atMs: number;
}): LivePriceTick | null {
  for (let index = ticks.length - 1; index >= 0; index -= 1) {
    const tick = ticks[index];
    if (tick !== undefined && tick.receivedAtMs <= atMs) {
      return tick;
    }
  }
  return null;
}

function marketLookbackStats({
  trades,
  placedAtMs,
  limitPrice,
  lookbackMs,
}: {
  readonly trades: readonly MarketDataTradeEvent[];
  readonly placedAtMs: number;
  readonly limitPrice: number;
  readonly lookbackMs: number;
}): DryPreEntryMarketLookback {
  const first = trades[0] ?? null;
  const last = trades[trades.length - 1] ?? null;
  const prices = trades.map((trade) => trade.price);
  const knownSizes = trades
    .map((trade) => trade.size)
    .filter((size): size is number => size !== null && size > 0);
  return {
    lookbackMs,
    tradeCount: trades.length,
    knownSizeTradeCount: knownSizes.length,
    totalKnownSize: knownSizes.reduce((acc, size) => acc + size, 0),
    firstTradeAtMs: first?.atMs ?? null,
    lastTradeAtMs: last?.atMs ?? null,
    lastTradeAgeMs: last === null ? null : Math.max(0, placedAtMs - last.atMs),
    firstPrice: first?.price ?? null,
    lastPrice: last?.price ?? null,
    minPrice: prices.length === 0 ? null : Math.min(...prices),
    maxPrice: prices.length === 0 ? null : Math.max(...prices),
    priceDelta:
      first === null || last === null ? null : last.price - first.price,
    atOrBelowLimitTradeCount: trades.filter(
      (trade) => trade.price <= limitPrice + PRICE_EPSILON,
    ).length,
    belowLimitTradeCount: trades.filter(
      (trade) => trade.price < limitPrice - PRICE_EPSILON,
    ).length,
  };
}

function estimatePolymarketFeeUsd({
  shares,
  price,
  feeRateBps,
}: {
  readonly shares: number;
  readonly price: number;
  readonly feeRateBps: number;
}): number {
  if (feeRateBps <= 0) {
    return 0;
  }
  const raw = shares * (feeRateBps / 10_000) * price * (1 - price);
  return Math.round(raw * 100_000) / 100_000;
}

function topForSide({
  book,
  side,
}: {
  readonly book: UpDownBook;
  readonly side: LeadingSide;
}): {
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly bidLevels?: readonly PriceLevel[];
  readonly askLevels?: readonly PriceLevel[];
} {
  return side === "up" ? book.up : book.down;
}

function spreadForTop({
  top,
}: {
  readonly top: {
    readonly bestBid: number | null;
    readonly bestAsk: number | null;
  };
}): number | null {
  return top.bestBid === null || top.bestAsk === null
    ? null
    : top.bestAsk - top.bestBid;
}

function sizeAtPrice({
  levels,
  price,
}: {
  readonly levels: readonly PriceLevel[] | undefined;
  readonly price: number;
}): number | null {
  if (levels === undefined) {
    return null;
  }
  return (
    levels.find((level) => Math.abs(level.price - price) < PRICE_EPSILON)
      ?.size ?? 0
  );
}

function sideForPrice({
  price,
  line,
}: {
  readonly price: number;
  readonly line: number;
}): LeadingSide {
  return price >= line ? "up" : "down";
}

function signedDistanceBp({
  price,
  line,
}: {
  readonly price: number;
  readonly line: number;
}): number {
  return ((price - line) / line) * 10_000;
}
