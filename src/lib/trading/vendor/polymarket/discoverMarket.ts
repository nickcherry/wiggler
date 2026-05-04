import { polymarket } from "@alea/constants/polymarket";
import type { TradableMarket } from "@alea/lib/trading/vendor/types";
import type { Asset } from "@alea/types/assets";
import { z } from "zod";

const FIVE_MINUTES_MS = 5 * 60 * 1000;

/**
 * What the gamma-api lookup returns when it finds the expected
 * up/down 5m market: the runner-facing `TradableMarket` plus the
 * vendor-internal flags the rest of the Polymarket adapter needs
 * (negRisk, primarily). The factory keeps these in a side-table
 * keyed by `vendorRef`/conditionId so the public type stays clean.
 */
export type DiscoveredPolymarketMarket = {
  readonly market: TradableMarket;
  readonly negRisk: boolean;
};

/**
 * Polymarket "up/down 5m" market lookup via the public gamma-api.
 * Slug is fixed by the venue: `<asset>-updown-5m-<unixSeconds>`,
 * where `unixSeconds` is the window *start* (UTC, aligned to 5min).
 *
 * Returns `null` when the slug doesn't resolve to anything that
 * matches the expected up/down shape (degenerate outcomes, missing
 * token ids, mismatched endDate). The runner treats `null` as
 * "skip this window".
 */
export async function discoverPolymarketMarket({
  asset,
  windowStartUnixSeconds,
  signal,
}: {
  readonly asset: Asset;
  readonly windowStartUnixSeconds: number;
  readonly signal?: AbortSignal;
}): Promise<DiscoveredPolymarketMarket | null> {
  const slug = `${asset}-updown-5m-${windowStartUnixSeconds}`;
  const url = `${polymarket.gammaApiUrl}/events?slug=${slug}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "alea/1.0" },
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `gamma-api /events?slug=${slug} failed: ${response.status} ${await response.text()}`,
    );
  }
  const parsed = eventListSchema.safeParse(await response.json());
  if (!parsed.success) {
    return null;
  }
  const event = parsed.data[0];
  const market = event?.markets[0];
  if (event === undefined || market === undefined) {
    return null;
  }
  const outcomes = parseStringArray(market.outcomes);
  const tokenIds = parseStringArray(market.clobTokenIds);
  if (
    outcomes === null ||
    tokenIds === null ||
    outcomes.length !== 2 ||
    tokenIds.length !== 2 ||
    outcomes[0] !== "Up" ||
    outcomes[1] !== "Down"
  ) {
    return null;
  }
  const upRef = tokenIds[0];
  const downRef = tokenIds[1];
  if (upRef === undefined || downRef === undefined) {
    return null;
  }
  const windowStartMs = windowStartUnixSeconds * 1000;
  return {
    market: {
      asset,
      windowStartUnixSeconds,
      windowStartMs,
      windowEndMs: windowStartMs + FIVE_MINUTES_MS,
      vendorRef: market.conditionId,
      upRef,
      downRef,
      acceptingOrders: market.acceptingOrders ?? false,
      displayLabel: slug,
    },
    negRisk: market.negRisk ?? false,
  };
}

function parseStringArray(value: string | undefined): string[] | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return null;
    }
    const out: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "string") {
        return null;
      }
      out.push(entry);
    }
    return out;
  } catch {
    return null;
  }
}

const marketSchema = z
  .object({
    conditionId: z.string(),
    outcomes: z.string().optional(),
    clobTokenIds: z.string().optional(),
    negRisk: z.boolean().optional(),
    acceptingOrders: z.boolean().optional(),
  })
  .passthrough();

const eventSchema = z
  .object({ slug: z.string(), markets: z.array(marketSchema) })
  .passthrough();

const eventListSchema = z.array(eventSchema);
