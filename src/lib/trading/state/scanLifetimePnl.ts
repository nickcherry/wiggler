import {
  computeLifetimePnl,
  type LifetimePnlBreakdown,
  type ScanMarketResolution,
  type ScanTrade,
} from "@alea/lib/trading/state/computeLifetimePnl";
import type { ClobClient } from "@polymarket/clob-client";
import { z } from "zod";

/** Narrow projection of a fill — only the fields the PnL math reads. */
type RawTrade = {
  readonly market: string;
  readonly asset_id: string;
  readonly side: string;
  readonly size: string;
  readonly price: string;
  readonly fee_rate_bps: string;
};

const TRADE_PAGE_LIMIT = 500;
const MARKET_LOOKUP_CONCURRENCY = 10;

export type ScanProgress =
  | {
      readonly kind: "trades-page";
      readonly tradesSoFar: number;
    }
  | {
      readonly kind: "markets-progress";
      readonly resolved: number;
      readonly total: number;
    };

/**
 * Computes the wallet's lifetime PnL by scanning every trade Polymarket
 * has on file for it. This is the boot-time hydration the live trader
 * runs whenever the on-disk checkpoint is missing or doesn't match
 * the running wallet. Steady-state operation maintains the value
 * incrementally per-window-settle, so the scan only fires once per
 * fresh wallet.
 *
 * Steps:
 *   1. Paginate `getTradesPaginated` until the cursor terminates.
 *      Polymarket signals "no more pages" by returning either an
 *      empty `next_cursor` or the sentinel `"LTE="` — handle both.
 *   2. For every unique conditionId we touched, fetch the market via
 *      the CLOB `getMarket` endpoint with bounded concurrency. The
 *      per-token `winner` flag (and `price` field of `0` or `1`)
 *      gives us the resolution.
 *   3. Hand both lists to the pure `computeLifetimePnl` summer.
 *
 * Unresolved markets (open, settling, or just dropped from `getMarket`)
 * are skipped and reported as a count — their cash flow can't be
 * realized yet.
 */
export async function scanLifetimePnlFromPolymarket({
  client,
  onProgress,
}: {
  readonly client: ClobClient;
  readonly onProgress?: (event: ScanProgress) => void;
}): Promise<LifetimePnlBreakdown> {
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

async function fetchAllTrades({
  client,
  onProgress,
}: {
  readonly client: ClobClient;
  readonly onProgress?: (event: ScanProgress) => void;
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
  readonly onProgress?: (event: ScanProgress) => void;
}): Promise<ScanMarketResolution[]> {
  const total = conditionIds.length;
  const results: ScanMarketResolution[] = [];
  let resolvedSoFar = 0;
  // Bounded concurrency: chunk into windows of MARKET_LOOKUP_CONCURRENCY.
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
        // Treat lookup failures as "unresolved" so we don't blow up
        // a long scan over a single venue hiccup. The summer will
        // skip these and surface them in `unresolvedMarketsSkipped`.
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
  // A market is "resolved" when at least one token reports
  // `winner: true` AND `price === 1`. Polymarket only sets these
  // post-settlement; until then both tokens look "active".
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

const paginatedTradesSchema = z
  .object({
    limit: z.number().optional(),
    count: z.number().optional(),
    next_cursor: z.string().optional(),
    data: z.array(
      z
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
        .passthrough(),
    ),
  })
  .passthrough();

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

void TRADE_PAGE_LIMIT;
