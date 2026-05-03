import { timeframeMs } from "@alea/lib/candles/timeframeMs";
import type { DatabaseClient } from "@alea/lib/db/types";
import type { Asset } from "@alea/types/assets";
import type { CandleTimeframe } from "@alea/types/candles";
import type { Product } from "@alea/types/products";
import type { CandleSource } from "@alea/types/sources";
import { sql } from "kysely";

type FindCandleGapsParams = {
  readonly db: DatabaseClient;
  readonly source: CandleSource;
  readonly asset: Asset;
  readonly product: Product;
  readonly timeframe: CandleTimeframe;
};

export type CandleGapRange = {
  readonly startMs: number;
  readonly endMs: number;
  readonly bars: number;
};

/**
 * Identifies gaps in the persisted candle series for `(source, asset,
 * product, timeframe)`. A gap is a run of consecutive bar timestamps between
 * the series' min and max where no row exists. Returned as half-open
 * `[startMs, endMs)` ranges so callers can plug them straight into a
 * fetch+upsert pass.
 *
 * Uses Postgres `generate_series` to enumerate the expected timestamp grid
 * server-side — far cheaper than streaming all rows back.
 */
export async function findCandleGaps({
  db,
  source,
  asset,
  product,
  timeframe,
}: FindCandleGapsParams): Promise<readonly CandleGapRange[]> {
  const barMs = timeframeMs({ timeframe });
  const intervalLiteral = `${barMs / 1000} seconds`;

  const rows = await sql<{ ts: Date }>`
    with bounds as (
      select min(timestamp) as lo, max(timestamp) as hi
      from candles
      where source = ${source}
        and asset = ${asset}
        and product = ${product}
        and timeframe = ${timeframe}
    ),
    expected as (
      select generate_series(
        (select lo from bounds),
        (select hi from bounds),
        ${intervalLiteral}::interval
      ) as ts
    )
    select e.ts as ts
    from expected e
    left join candles c
      on c.source = ${source}
     and c.asset = ${asset}
     and c.product = ${product}
     and c.timeframe = ${timeframe}
     and c.timestamp = e.ts
    where c.timestamp is null
    order by e.ts
  `.execute(db);

  if (rows.rows.length === 0) {
    return [];
  }

  const ranges: CandleGapRange[] = [];
  let runStartMs = rows.rows[0]!.ts.getTime();
  let runEndMs = runStartMs;

  for (let i = 1; i < rows.rows.length; i++) {
    const ms = rows.rows[i]!.ts.getTime();
    if (ms - runEndMs === barMs) {
      runEndMs = ms;
    } else {
      ranges.push({
        startMs: runStartMs,
        endMs: runEndMs + barMs,
        bars: (runEndMs - runStartMs) / barMs + 1,
      });
      runStartMs = ms;
      runEndMs = ms;
    }
  }
  ranges.push({
    startMs: runStartMs,
    endMs: runEndMs + barMs,
    bars: (runEndMs - runStartMs) / barMs + 1,
  });
  return ranges;
}
