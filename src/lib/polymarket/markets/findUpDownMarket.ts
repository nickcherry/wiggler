import { polymarket } from "@alea/constants/polymarket";
import type { UpDownMarket } from "@alea/lib/polymarket/markets/types";
import type { Asset } from "@alea/types/assets";
import { z } from "zod";

const FIVE_MINUTES_MS = 5 * 60 * 1000;

/**
 * Looks up the Polymarket "up/down 5m" market for a given
 * `(asset, windowStart)` pair via the public gamma-api. The slug
 * pattern is fixed by Polymarket: `<asset>-updown-5m-<unixSeconds>`,
 * where the unix-seconds value is the *window start* (UTC), aligned
 * to a 5-minute boundary.
 *
 * Returns `null` when the market doesn't exist yet or the slug
 * resolves to anything that doesn't match the expected up/down shape
 * (degenerate outcomes, missing token ids, mismatched endDate, etc.).
 * The dry-run runner treats `null` as "skip this window"; the live
 * runner (chunk 2) will retry in a tight loop near window open.
 */
export async function findUpDownMarket({
  asset,
  windowStartUnixSeconds,
  signal,
}: {
  readonly asset: Asset;
  readonly windowStartUnixSeconds: number;
  readonly signal?: AbortSignal;
}): Promise<UpDownMarket | null> {
  const slug = buildSlug({ asset, windowStartUnixSeconds });
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
  const raw = await response.json();
  const parsed = eventListSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const event = parsed.data[0];
  if (event === undefined) {
    return null;
  }
  const market = event.markets[0];
  if (market === undefined) {
    return null;
  }
  // Defensive parses on the JSON-stringified arrays — gamma-api returns
  // these as strings rather than nested arrays.
  const outcomes = parseStringArray(market.outcomes);
  const tokenIds = parseStringArray(market.clobTokenIds);
  if (outcomes === null || tokenIds === null) {
    return null;
  }
  if (outcomes.length !== 2 || tokenIds.length !== 2) {
    return null;
  }
  if (outcomes[0] !== "Up" || outcomes[1] !== "Down") {
    return null;
  }
  const upYesTokenId = tokenIds[0];
  const downYesTokenId = tokenIds[1];
  if (upYesTokenId === undefined || downYesTokenId === undefined) {
    return null;
  }
  const windowStartMs = windowStartUnixSeconds * 1000;
  const windowEndMs = windowStartMs + FIVE_MINUTES_MS;
  return {
    asset,
    windowStartUnixSeconds,
    windowStartMs,
    windowEndMs,
    slug,
    conditionId: market.conditionId,
    upYesTokenId,
    downYesTokenId,
    negRisk: market.negRisk ?? false,
    acceptingOrders: market.acceptingOrders ?? false,
  };
}

function buildSlug({
  asset,
  windowStartUnixSeconds,
}: {
  readonly asset: Asset;
  readonly windowStartUnixSeconds: number;
}): string {
  return `${asset}-updown-5m-${windowStartUnixSeconds}`;
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
  .object({
    slug: z.string(),
    markets: z.array(marketSchema),
  })
  .passthrough();

const eventListSchema = z.array(eventSchema);
