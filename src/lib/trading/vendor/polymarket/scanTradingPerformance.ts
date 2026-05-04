import {
  buildTradingPerformancePayload,
  type TradingPerformanceInputMarket,
  type TradingPerformanceInputTrade,
} from "@alea/lib/trading/performance/buildTradingPerformancePayload";
import type { TradingPerformancePayload } from "@alea/lib/trading/performance/types";
import type { ClobClient } from "@polymarket/clob-client";
import { z } from "zod";

const MARKET_LOOKUP_CONCURRENCY = 10;

export type TradingPerformanceScanProgress =
  | { readonly kind: "trades-page"; readonly tradesSoFar: number }
  | {
      readonly kind: "markets-progress";
      readonly resolved: number;
      readonly total: number;
    };

export async function scanPolymarketTradingPerformance({
  client,
  walletAddress,
  generatedAtMs = Date.now(),
  onProgress,
}: {
  readonly client: ClobClient;
  readonly walletAddress: string;
  readonly generatedAtMs?: number;
  readonly onProgress?: (event: TradingPerformanceScanProgress) => void;
}): Promise<TradingPerformancePayload> {
  const trades = await fetchAllTrades({ client, onProgress });
  const conditionIds = uniqueConditionIds({ trades });
  const markets = await fetchAllMarkets({ client, conditionIds, onProgress });
  return buildTradingPerformancePayload({
    walletAddress,
    generatedAtMs,
    trades: trades.map(toInputTrade),
    markets,
  });
}

type RawTrade = {
  readonly id: string;
  readonly market: string;
  readonly asset_id: string;
  readonly side: string;
  readonly size: string;
  readonly price: string;
  readonly fee_rate_bps: string;
  readonly match_time?: string;
  readonly last_update?: string;
  readonly outcome?: string;
  readonly transaction_hash?: string;
  readonly trader_side?: string;
};

async function fetchAllTrades({
  client,
  onProgress,
}: {
  readonly client: ClobClient;
  readonly onProgress?: (event: TradingPerformanceScanProgress) => void;
}): Promise<RawTrade[]> {
  const accumulator: RawTrade[] = [];
  let cursor: string | undefined;
  while (true) {
    const response: unknown = await client.getTradesPaginated({}, cursor);
    const parsed = paginatedTradesSchema.safeParse(response);
    if (!parsed.success) {
      throw new Error(
        `getTradesPaginated returned an unexpected shape: ${parsed.error.message}`,
      );
    }
    if (parsed.data.data.length > 0) {
      accumulator.push(...parsed.data.data);
      onProgress?.({
        kind: "trades-page",
        tradesSoFar: accumulator.length,
      });
    }
    const next = parsed.data.next_cursor;
    if (next === undefined || next === "" || next === "LTE=") {
      return accumulator;
    }
    cursor = next;
  }
}

async function fetchAllMarkets({
  client,
  conditionIds,
  onProgress,
}: {
  readonly client: ClobClient;
  readonly conditionIds: readonly string[];
  readonly onProgress?: (event: TradingPerformanceScanProgress) => void;
}): Promise<TradingPerformanceInputMarket[]> {
  const total = conditionIds.length;
  const results: TradingPerformanceInputMarket[] = [];
  let resolvedSoFar = 0;
  for (let i = 0; i < conditionIds.length; i += MARKET_LOOKUP_CONCURRENCY) {
    const slice = conditionIds.slice(i, i + MARKET_LOOKUP_CONCURRENCY);
    const settled = await Promise.allSettled(
      slice.map((conditionId) => fetchMarket({ client, conditionId })),
    );
    for (let index = 0; index < settled.length; index += 1) {
      const item = settled[index];
      const conditionId = slice[index];
      if (item?.status === "fulfilled") {
        results.push(item.value);
      } else if (conditionId !== undefined) {
        results.push(unresolvedMarket({ conditionId }));
      }
    }
    resolvedSoFar = Math.min(total, resolvedSoFar + slice.length);
    onProgress?.({
      kind: "markets-progress",
      resolved: resolvedSoFar,
      total,
    });
  }
  return results;
}

async function fetchMarket({
  client,
  conditionId,
}: {
  readonly client: ClobClient;
  readonly conditionId: string;
}): Promise<TradingPerformanceInputMarket> {
  const response: unknown = await client.getMarket(conditionId);
  const parsed = marketSchema.safeParse(response);
  if (!parsed.success) {
    return unresolvedMarket({ conditionId });
  }
  return {
    conditionId: parsed.data.condition_id ?? conditionId,
    question: parsed.data.question ?? null,
    marketSlug: parsed.data.market_slug ?? parsed.data.slug ?? null,
    endDateMs: parseDateMs(parsed.data.end_date_iso ?? null),
    closed: parsed.data.closed ?? false,
    tokens: parsed.data.tokens.map((token) => ({
      tokenId: token.token_id,
      outcome: token.outcome ?? null,
      price: token.price,
      winner: token.winner ?? false,
    })),
  };
}

function unresolvedMarket({
  conditionId,
}: {
  readonly conditionId: string;
}): TradingPerformanceInputMarket {
  return {
    conditionId,
    question: null,
    marketSlug: null,
    endDateMs: null,
    closed: false,
    tokens: [],
  };
}

function uniqueConditionIds({
  trades,
}: {
  readonly trades: readonly RawTrade[];
}): string[] {
  const set = new Set<string>();
  for (const trade of trades) {
    if (trade.market.length > 0) {
      set.add(trade.market);
    }
  }
  return [...set];
}

function toInputTrade(trade: RawTrade): TradingPerformanceInputTrade {
  const size = Number(trade.size);
  const price = Number(trade.price);
  const feeRateBps =
    trade.trader_side === "MAKER" ? 0 : Number(trade.fee_rate_bps);
  return {
    id: trade.id,
    conditionId: trade.market,
    tokenId: trade.asset_id,
    side: trade.side === "SELL" ? "SELL" : "BUY",
    traderSide: parseTraderSide({ value: trade.trader_side }),
    size: Number.isFinite(size) ? size : 0,
    price: Number.isFinite(price) ? price : 0,
    feeRateBps: Number.isFinite(feeRateBps) ? feeRateBps : 0,
    tradeTimeMs: parseTradeTimeMs({
      matchTime: trade.match_time,
      lastUpdate: trade.last_update,
    }),
    outcome: trade.outcome ?? null,
    transactionHash: trade.transaction_hash ?? null,
  };
}

function parseTraderSide({
  value,
}: {
  readonly value: string | undefined;
}): "MAKER" | "TAKER" | "UNKNOWN" {
  if (value === "MAKER" || value === "TAKER") {
    return value;
  }
  return "UNKNOWN";
}

function parseTradeTimeMs({
  matchTime,
  lastUpdate,
}: {
  readonly matchTime?: string;
  readonly lastUpdate?: string;
}): number {
  for (const candidate of [matchTime, lastUpdate]) {
    if (candidate === undefined || candidate.length === 0) {
      continue;
    }
    const numeric = Number(candidate);
    if (Number.isFinite(numeric)) {
      return numeric > 10_000_000_000 ? numeric : numeric * 1000;
    }
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function parseDateMs(value: string | null): number | null {
  if (value === null || value.length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const numericOrNullSchema = z.preprocess((value) => {
  if (value === null || value === undefined) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}, z.number().nullable());

const rawTradeSchema = z
  .object({
    id: z.string(),
    market: z.string(),
    asset_id: z.string(),
    side: z.string(),
    size: z.string(),
    price: z.string(),
    fee_rate_bps: z.string(),
    match_time: z.string().optional(),
    last_update: z.string().optional(),
    outcome: z.string().optional(),
    transaction_hash: z.string().optional(),
    trader_side: z.string().optional(),
  })
  .passthrough();

const paginatedTradesSchema = z
  .object({
    limit: z.number().optional(),
    count: z.number().optional(),
    next_cursor: z.string().optional(),
    data: z.array(rawTradeSchema).optional(),
    trades: z.array(rawTradeSchema).optional(),
  })
  .passthrough()
  .refine(
    (response) => response.data !== undefined || response.trades !== undefined,
    "expected data or trades array",
  )
  .transform((response) => ({
    ...response,
    data: response.trades ?? response.data ?? [],
  }));

const marketSchema = z
  .object({
    condition_id: z.string().optional(),
    question: z.string().optional(),
    market_slug: z.string().optional(),
    slug: z.string().optional(),
    end_date_iso: z.string().nullable().optional(),
    closed: z.boolean().optional(),
    tokens: z
      .array(
        z
          .object({
            token_id: z.string(),
            outcome: z.string().optional(),
            price: numericOrNullSchema,
            winner: z.boolean().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
