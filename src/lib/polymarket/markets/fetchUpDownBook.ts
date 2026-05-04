import { polymarket } from "@alea/constants/polymarket";
import type {
  TopOfBook,
  UpDownBookSnapshot,
  UpDownMarket,
} from "@alea/lib/polymarket/markets/types";
import { z } from "zod";

/**
 * Fetches the top of book for both YES tokens of an up/down market via
 * the public CLOB REST endpoint. Used by the dry-run loop to compute
 * Polymarket's implied probability for each side at low cadence (no
 * auth, no order placement). Chunk 2 swaps this for the market WS
 * subscription so the live trader can react to book moves between
 * polls.
 *
 * Returns `null` for `bestBid`/`bestAsk` when there are no resting
 * orders on that side — common in the first minute of a fresh
 * market.
 */
export async function fetchUpDownBook({
  market,
  signal,
}: {
  readonly market: UpDownMarket;
  readonly signal?: AbortSignal;
}): Promise<UpDownBookSnapshot> {
  const [up, down] = await Promise.all([
    fetchTopOfBook({ tokenId: market.upYesTokenId, signal }),
    fetchTopOfBook({ tokenId: market.downYesTokenId, signal }),
  ]);
  return { market, up, down };
}

async function fetchTopOfBook({
  tokenId,
  signal,
}: {
  readonly tokenId: string;
  readonly signal?: AbortSignal;
}): Promise<TopOfBook> {
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
  return {
    tokenId,
    bestBid: pickBest({ levels: parsed.bids, side: "bid" }),
    bestAsk: pickBest({ levels: parsed.asks, side: "ask" }),
    fetchedAtMs: Date.now(),
  };
}

/**
 * Polymarket returns book levels as `{ price: "0.55", size: "..." }`
 * arrays, conventionally sorted ascending by price for both sides. We
 * pick the top of book ourselves rather than trusting any particular
 * ordering — the cost is `O(n)` over a handful of levels.
 */
function pickBest({
  levels,
  side,
}: {
  readonly levels: readonly { readonly price: string; readonly size: string }[];
  readonly side: "bid" | "ask";
}): number | null {
  let best: number | null = null;
  for (const level of levels) {
    const price = Number(level.price);
    const size = Number(level.size);
    if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) {
      continue;
    }
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

const levelSchema = z.object({
  price: z.string(),
  size: z.string(),
});

const bookSchema = z
  .object({
    bids: z.array(levelSchema),
    asks: z.array(levelSchema),
  })
  .passthrough();
