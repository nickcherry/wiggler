import { polymarket } from "@alea/constants/polymarket";
import {
  mergePolymarketOrderConstraints,
  parseBookConstraints,
} from "@alea/lib/trading/vendor/polymarket/marketConstraints";
import type {
  PriceLevel,
  TopOfBook,
  TradableMarket,
  UpDownBook,
} from "@alea/lib/trading/vendor/types";
import { z } from "zod";

/**
 * Fetches the top of book for both YES tokens of an up/down market via
 * the public CLOB REST endpoint. Two parallel calls per market — no
 * auth needed.
 *
 * Returns `null` for `bestBid`/`bestAsk` when there are no resting
 * orders on that side (common in the first minute of a fresh market).
 */
export async function fetchPolymarketBook({
  market,
  signal,
}: {
  readonly market: TradableMarket;
  readonly signal?: AbortSignal;
}): Promise<UpDownBook> {
  const [up, down] = await Promise.all([
    fetchTokenBook({ tokenId: market.upRef, signal }),
    fetchTokenBook({ tokenId: market.downRef, signal }),
  ]);
  const constraintItems = [
    market.constraints,
    up.constraints,
    down.constraints,
  ];
  const hasConstraints = constraintItems.some(
    (item) => item !== undefined && item !== null,
  );
  const constraints = hasConstraints
    ? mergePolymarketOrderConstraints(...constraintItems)
    : undefined;
  return {
    market: constraints === undefined ? market : { ...market, constraints },
    up,
    down,
    fetchedAtMs: Date.now(),
  };
}

type TokenBook = TopOfBook & {
  readonly constraints:
    | ReturnType<typeof parseBookConstraints>
    | null
    | undefined;
};

async function fetchTokenBook({
  tokenId,
  signal,
}: {
  readonly tokenId: string;
  readonly signal?: AbortSignal;
}): Promise<TokenBook> {
  const url = `${polymarket.clobApiUrl}/book?token_id=${tokenId}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "alea/1.0" },
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `CLOB /book?token_id=${tokenId} failed: ${response.status} ${await response.text()}`,
    );
  }
  const parsed = bookSchema.parse(await response.json());
  const bids = parseLevels({ levels: parsed.bids });
  const asks = parseLevels({ levels: parsed.asks });
  return {
    bestBid: pickBest({ levels: bids, side: "bid" }),
    bestAsk: pickBest({ levels: asks, side: "ask" }),
    bidLevels: bids,
    askLevels: asks,
    constraints: parseBookConstraints({ raw: parsed }),
  };
}

/**
 * Polymarket returns book levels as `{ price: "0.55", size: "..." }`
 * arrays. Conventional ordering varies by side so we scan and pick
 * the top — the cost is `O(n)` over a handful of levels.
 */
function pickBest({
  levels,
  side,
}: {
  readonly levels: readonly PriceLevel[];
  readonly side: "bid" | "ask";
}): number | null {
  let best: number | null = null;
  for (const level of levels) {
    const price = level.price;
    if (best === null) {
      best = price;
      continue;
    }
    if (side === "bid" ? price > best : price < best) {
      best = price;
    }
  }
  return best;
}

function parseLevels({
  levels,
}: {
  readonly levels: readonly { readonly price: string; readonly size: string }[];
}): PriceLevel[] {
  const out: PriceLevel[] = [];
  for (const level of levels) {
    const price = Number(level.price);
    const size = Number(level.size);
    if (
      !Number.isFinite(price) ||
      !Number.isFinite(size) ||
      price <= 0 ||
      size <= 0
    ) {
      continue;
    }
    out.push({ price, size });
  }
  return out;
}

const levelSchema = z.object({ price: z.string(), size: z.string() });

const bookSchema = z
  .object({
    bids: z.array(levelSchema),
    asks: z.array(levelSchema),
    min_order_size: z.string().optional(),
    tick_size: z.string().optional(),
    neg_risk: z.boolean().optional(),
  })
  .passthrough();
