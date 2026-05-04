import { assetValues } from "@alea/constants/assets";
import type {
  TradingPerformanceChartPoint,
  TradingPerformanceMarketRow,
  TradingPerformancePayload,
  TradingPerformanceTradeResult,
  TradingPerformanceTradeRow,
} from "@alea/lib/trading/performance/types";
import { computePolymarketFeeUsd } from "@alea/lib/trading/vendor/polymarket/computePolymarketFeeUsd";

export type TradingPerformanceInputTrade = {
  readonly id: string;
  readonly conditionId: string;
  readonly tokenId: string;
  readonly side: "BUY" | "SELL";
  readonly traderSide: "MAKER" | "TAKER" | "UNKNOWN";
  readonly size: number;
  readonly price: number;
  readonly feeRateBps: number;
  readonly tradeTimeMs: number;
  readonly outcome: string | null;
  readonly transactionHash: string | null;
};

export type TradingPerformanceInputMarket = {
  readonly conditionId: string;
  readonly question: string | null;
  readonly marketSlug: string | null;
  readonly endDateMs: number | null;
  readonly closed: boolean;
  readonly tokens: readonly TradingPerformanceInputToken[];
};

export type TradingPerformanceInputToken = {
  readonly tokenId: string;
  readonly outcome: string | null;
  readonly price: number | null;
  readonly winner: boolean;
};

type MarketResolution = {
  readonly resolved: boolean;
  readonly winningOutcome: string | null;
  readonly outcomePriceByTokenId: ReadonlyMap<string, number>;
};

export function buildTradingPerformancePayload({
  walletAddress,
  generatedAtMs,
  trades,
  markets,
}: {
  readonly walletAddress: string;
  readonly generatedAtMs: number;
  readonly trades: readonly TradingPerformanceInputTrade[];
  readonly markets: readonly TradingPerformanceInputMarket[];
}): TradingPerformancePayload {
  const marketByConditionId = new Map(
    markets.map((market) => [market.conditionId, market] as const),
  );
  const tradeRows = trades
    .map((trade) =>
      buildTradeRow({
        trade,
        market: marketByConditionId.get(trade.conditionId) ?? null,
      }),
    )
    .sort((a, b) => b.tradeTimeMs - a.tradeTimeMs || a.id.localeCompare(b.id));
  const marketRows = buildMarketRows({
    tradeRows,
    marketByConditionId,
  });
  const chart = buildChart({ marketRows });
  const resolvedRows = tradeRows.filter((row) => row.pnlUsd !== null);
  const firstTradeAtMs = minOrNull(tradeRows.map((row) => row.tradeTimeMs));
  const lastTradeAtMs = maxOrNull(tradeRows.map((row) => row.tradeTimeMs));

  return {
    command: "trading:performance",
    generatedAtMs,
    walletAddress,
    source: {
      trades: "Polymarket CLOB /data/trades via getTradesPaginated",
      markets: "Polymarket CLOB /markets/{conditionId} via getMarket",
      fees: "Polymarket CLOB fee formula: shares * feeRate * price * (1 - price), rounded to five decimals",
    },
    summary: {
      walletAddress,
      tradeCount: tradeRows.length,
      resolvedTradeCount: resolvedRows.length,
      unresolvedTradeCount: tradeRows.length - resolvedRows.length,
      resolvedMarketCount: marketRows.filter((row) => row.resolved).length,
      unresolvedMarketCount: marketRows.filter((row) => !row.resolved).length,
      winningTradeCount: tradeRows.filter((row) => row.result === "win").length,
      losingTradeCount: tradeRows.filter((row) => row.result === "loss").length,
      flatTradeCount: tradeRows.filter((row) => row.result === "flat").length,
      lifetimePnlUsd: sum(resolvedRows.map((row) => row.pnlUsd ?? 0)),
      resolvedFeesUsd: sum(resolvedRows.map((row) => row.feeUsd)),
      totalFeesUsd: sum(tradeRows.map((row) => row.feeUsd)),
      totalVolumeUsd: sum(tradeRows.map((row) => row.notionalUsd)),
      firstTradeAtMs,
      lastTradeAtMs,
    },
    chart,
    markets: marketRows,
    trades: tradeRows,
  };
}

function buildTradeRow({
  trade,
  market,
}: {
  readonly trade: TradingPerformanceInputTrade;
  readonly market: TradingPerformanceInputMarket | null;
}): TradingPerformanceTradeRow {
  const resolution =
    market === null
      ? unresolvedResolution()
      : resolveMarketResolution({ market });
  const token = market?.tokens.find((item) => item.tokenId === trade.tokenId);
  const question = market?.question ?? "Unknown Polymarket market";
  const marketSlug = market?.marketSlug ?? null;
  const outcome = token?.outcome ?? trade.outcome ?? "Unknown";
  const symbol = inferSymbol({ marketSlug, question, outcome });
  const notionalUsd = trade.size * trade.price;
  const feeUsd =
    trade.traderSide === "MAKER"
      ? 0
      : computePolymarketFeeUsd({
          size: trade.size,
          price: trade.price,
          feeRateBps: trade.feeRateBps,
        });
  const resolvedPrice = resolution.resolved
    ? (resolution.outcomePriceByTokenId.get(trade.tokenId) ?? 0)
    : null;
  const pnlUsd =
    resolvedPrice === null
      ? null
      : computeTradePnl({
          side: trade.side,
          size: trade.size,
          price: trade.price,
          resolvedPrice,
          feeUsd,
        });
  return {
    id: trade.id,
    conditionId: trade.conditionId,
    tokenId: trade.tokenId,
    symbol,
    question,
    marketSlug,
    side: trade.side,
    traderSide: trade.traderSide,
    outcome,
    size: trade.size,
    price: trade.price,
    notionalUsd,
    feeRateBps: trade.feeRateBps,
    feeUsd,
    tradeTimeMs: trade.tradeTimeMs,
    resolved: resolution.resolved,
    resolvedPrice,
    pnlUsd,
    result: resultFromPnl({ pnlUsd }),
    transactionHash: trade.transactionHash,
  };
}

function buildMarketRows({
  tradeRows,
  marketByConditionId,
}: {
  readonly tradeRows: readonly TradingPerformanceTradeRow[];
  readonly marketByConditionId: ReadonlyMap<
    string,
    TradingPerformanceInputMarket
  >;
}): TradingPerformanceMarketRow[] {
  const rowsByMarket = new Map<string, TradingPerformanceTradeRow[]>();
  for (const row of tradeRows) {
    const list = rowsByMarket.get(row.conditionId);
    if (list === undefined) {
      rowsByMarket.set(row.conditionId, [row]);
    } else {
      list.push(row);
    }
  }
  const marketRows: TradingPerformanceMarketRow[] = [];
  for (const [conditionId, rows] of rowsByMarket) {
    const market = marketByConditionId.get(conditionId) ?? null;
    const resolution =
      market === null
        ? unresolvedResolution()
        : resolveMarketResolution({ market });
    const latestTradeAtMs = maxOrNull(rows.map((row) => row.tradeTimeMs));
    const endDateMs = market?.endDateMs ?? null;
    const settledAtMs =
      resolution.resolved && latestTradeAtMs !== null
        ? Math.max(endDateMs ?? latestTradeAtMs, latestTradeAtMs)
        : null;
    marketRows.push({
      conditionId,
      symbol: rows[0]?.symbol ?? "UNKNOWN",
      question:
        market?.question ?? rows[0]?.question ?? "Unknown Polymarket market",
      marketSlug: market?.marketSlug ?? rows[0]?.marketSlug ?? null,
      endDateMs,
      settledAtMs,
      resolved: resolution.resolved,
      winningOutcome: resolution.winningOutcome,
      tradeCount: rows.length,
      volumeUsd: sum(rows.map((row) => row.notionalUsd)),
      feesUsd: sum(rows.map((row) => row.feeUsd)),
      pnlUsd: resolution.resolved
        ? sum(rows.map((row) => row.pnlUsd ?? 0))
        : null,
    });
  }
  return marketRows.sort(
    (a, b) =>
      (b.settledAtMs ?? 0) - (a.settledAtMs ?? 0) ||
      b.tradeCount - a.tradeCount ||
      a.conditionId.localeCompare(b.conditionId),
  );
}

function buildChart({
  marketRows,
}: {
  readonly marketRows: readonly TradingPerformanceMarketRow[];
}): TradingPerformanceChartPoint[] {
  const resolvedRows = marketRows
    .filter(
      (
        row,
      ): row is TradingPerformanceMarketRow & {
        readonly pnlUsd: number;
        readonly settledAtMs: number;
      } => row.pnlUsd !== null && row.settledAtMs !== null,
    )
    .sort(
      (a, b) =>
        a.settledAtMs - b.settledAtMs ||
        a.conditionId.localeCompare(b.conditionId),
    );
  let cumulative = 0;
  const points: TradingPerformanceChartPoint[] = [];
  for (const row of resolvedRows) {
    cumulative += row.pnlUsd;
    points.push({
      conditionId: row.conditionId,
      symbol: row.symbol,
      question: row.question,
      settledAtMs: row.settledAtMs,
      marketPnlUsd: row.pnlUsd,
      cumulativePnlUsd: cumulative,
    });
  }
  return points;
}

function resolveMarketResolution({
  market,
}: {
  readonly market: TradingPerformanceInputMarket;
}): MarketResolution {
  const map = new Map<string, number>();
  let winningOutcome: string | null = null;
  let sawWinner = false;
  for (const token of market.tokens) {
    if (token.price === null) {
      continue;
    }
    map.set(token.tokenId, token.price);
    if (token.winner || token.price === 1) {
      sawWinner = true;
      winningOutcome = token.outcome ?? winningOutcome;
    }
  }
  const binaryResolved =
    map.size > 0 &&
    [...map.values()].every((price) => price === 0 || price === 1);
  if (!market.closed || !sawWinner || !binaryResolved) {
    return unresolvedResolution();
  }
  return {
    resolved: true,
    winningOutcome,
    outcomePriceByTokenId: map,
  };
}

function unresolvedResolution(): MarketResolution {
  return {
    resolved: false,
    winningOutcome: null,
    outcomePriceByTokenId: new Map(),
  };
}

function computeTradePnl({
  side,
  size,
  price,
  resolvedPrice,
  feeUsd,
}: {
  readonly side: "BUY" | "SELL";
  readonly size: number;
  readonly price: number;
  readonly resolvedPrice: number;
  readonly feeUsd: number;
}): number {
  const cashFlow = side === "BUY" ? -size * price : size * price;
  const shares = side === "BUY" ? size : -size;
  return cashFlow + shares * resolvedPrice - feeUsd;
}

function resultFromPnl({
  pnlUsd,
}: {
  readonly pnlUsd: number | null;
}): TradingPerformanceTradeResult {
  if (pnlUsd === null) {
    return "open";
  }
  if (pnlUsd > 0) {
    return "win";
  }
  if (pnlUsd < 0) {
    return "loss";
  }
  return "flat";
}

function inferSymbol({
  marketSlug,
  question,
  outcome,
}: {
  readonly marketSlug: string | null;
  readonly question: string;
  readonly outcome: string;
}): string {
  const slug = marketSlug?.toLowerCase() ?? "";
  for (const asset of assetValues) {
    if (
      slug === asset ||
      slug.startsWith(`${asset}-`) ||
      slug.includes(`-${asset}-`) ||
      slug.includes(`${asset}up`) ||
      slug.includes(`${asset}-updown`)
    ) {
      return asset.toUpperCase();
    }
  }
  const haystack = `${question} ${outcome}`.toUpperCase();
  for (const asset of assetValues) {
    const upper = asset.toUpperCase();
    if (new RegExp(`\\b${upper}\\b`).test(haystack)) {
      return upper;
    }
  }
  return "POLY";
}

function minOrNull(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return Math.min(...values);
}

function maxOrNull(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return Math.max(...values);
}

function sum(values: readonly number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}
