import {
  computeLifetimePnl,
  type ScanMarketResolution,
  type ScanTrade,
} from "@alea/lib/trading/state/computeLifetimePnl";
import type {
  LifetimePnlScanProgress,
  LifetimePnlScanResult,
} from "@alea/lib/trading/vendor/types";
import type { ClobClient } from "@polymarket/clob-client";
import { z } from "zod";

const MARKET_LOOKUP_CONCURRENCY = 10;

/**
 * Polymarket implementation of `Vendor.scanLifetimePnl`. Scans the
 * wallet's full trade history paginated through `getTradesPaginated`,
 * resolves each unique market via `getMarket`, and hands both lists
 * to the pure `computeLifetimePnl` summer.
 *
 * Latency dominates this call (paginated reads + per-market lookups);
 * the runner only invokes it on cold start and the standalone
 * `trading:hydrate-lifetime-pnl` CLI re-runs it on demand. The
 * `onProgress` callback emits `trades-page` after each page lands and
 * `markets-progress` as resolution batches land.
 */
export async function scanPolymarketLifetimePnl({
  client,
  onProgress,
}: {
  readonly client: ClobClient;
  readonly onProgress?: (event: LifetimePnlScanProgress) => void;
}): Promise<LifetimePnlScanResult> {
  const trades = await fetchAllTrades({ client, onProgress });
  const conditionIds = uniqueConditionIds({ trades });
  const resolutions = await fetchAllResolutions({
    client,
    conditionIds,
    onProgress,
  });
  return computeLifetimePnl({
    trades: trades.map(toScanTrade),
    resolutions,
  });
}

type RawTrade = {
  readonly market: string;
  readonly asset_id: string;
  readonly side: string;
  readonly size: string;
  readonly price: string;
  readonly fee_rate_bps: string;
};

async function fetchAllTrades({
  client,
  onProgress,
}: {
  readonly client: ClobClient;
  readonly onProgress?: (event: LifetimePnlScanProgress) => void;
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

async function fetchAllResolutions({
  client,
  conditionIds,
  onProgress,
}: {
  readonly client: ClobClient;
  readonly conditionIds: readonly string[];
  readonly onProgress?: (event: LifetimePnlScanProgress) => void;
}): Promise<ScanMarketResolution[]> {
  const total = conditionIds.length;
  const results: ScanMarketResolution[] = [];
  let resolvedSoFar = 0;
  for (let i = 0; i < conditionIds.length; i += MARKET_LOOKUP_CONCURRENCY) {
    const slice = conditionIds.slice(i, i + MARKET_LOOKUP_CONCURRENCY);
    const settled = await Promise.allSettled(
      slice.map((conditionId) =>
        fetchMarketResolution({ client, conditionId }),
      ),
    );
    for (const item of settled) {
      if (item.status === "fulfilled") {
        results.push(item.value);
      } else {
        // Single hiccup → treat as unresolved, the summer skips it.
        results.push({
          conditionId: "",
          resolved: false,
          outcomePriceByTokenId: new Map(),
        });
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

async function fetchMarketResolution({
  client,
  conditionId,
}: {
  readonly client: ClobClient;
  readonly conditionId: string;
}): Promise<ScanMarketResolution> {
  const response: unknown = await client.getMarket(conditionId);
  const parsed = marketResolutionSchema.safeParse(response);
  if (!parsed.success) {
    return {
      conditionId,
      resolved: false,
      outcomePriceByTokenId: new Map(),
    };
  }
  const map = new Map<string, number>();
  let resolved = false;
  for (const token of parsed.data.tokens) {
    map.set(token.token_id, token.price);
    if (token.winner && token.price === 1) {
      resolved = true;
    }
  }
  if (!resolved) {
    return {
      conditionId,
      resolved: false,
      outcomePriceByTokenId: new Map(),
    };
  }
  return {
    conditionId,
    resolved: true,
    outcomePriceByTokenId: map,
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

function toScanTrade(trade: RawTrade): ScanTrade {
  const size = Number(trade.size);
  const price = Number(trade.price);
  const feeRateBps = Number(trade.fee_rate_bps);
  return {
    conditionId: trade.market,
    tokenId: trade.asset_id,
    side: trade.side === "BUY" ? "BUY" : "SELL",
    size: Number.isFinite(size) ? size : 0,
    price: Number.isFinite(price) ? price : 0,
    feeRateBps: Number.isFinite(feeRateBps) ? feeRateBps : 0,
  };
}

const rawTradeSchema = z
  .object({
    id: z.string(),
    market: z.string(),
    asset_id: z.string(),
    side: z.string(),
    size: z.string(),
    price: z.string(),
    fee_rate_bps: z.string(),
    status: z.string().optional(),
    match_time: z.string().optional(),
    last_update: z.string().optional(),
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

const marketResolutionSchema = z
  .object({
    condition_id: z.string().optional(),
    closed: z.boolean().optional(),
    tokens: z
      .array(
        z
          .object({
            token_id: z.string(),
            outcome: z.string().optional(),
            price: z.number(),
            winner: z.boolean().optional(),
          })
          .passthrough(),
      )
      .transform((arr) =>
        arr.map((t) => ({
          token_id: t.token_id,
          price: t.price,
          winner: t.winner ?? false,
        })),
      ),
  })
  .passthrough();
