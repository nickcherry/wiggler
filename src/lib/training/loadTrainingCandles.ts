import { trainingCandleSeries } from "@alea/constants/training";
import type { DatabaseClient } from "@alea/lib/db/types";
import type { Asset } from "@alea/types/assets";
import type { Candle } from "@alea/types/candles";

/**
 * Reads every candle for one asset out of the local Postgres, filtered to
 * the single `(source, product, timeframe)` series the training domain
 * studies (see `src/constants/training.ts`). Rows come back ascending by
 * timestamp so downstream code can rely on chronological order without an
 * extra sort.
 *
 * No paging — for one asset on 5-minute bars over a few-year backfill we are
 * looking at ~hundreds of thousands of rows, which fits comfortably in
 * memory.
 */
export async function loadTrainingCandles({
  db,
  asset,
}: {
  readonly db: DatabaseClient;
  readonly asset: Asset;
}): Promise<Candle[]> {
  const rows = await db
    .selectFrom("candles")
    .select([
      "source",
      "asset",
      "product",
      "timeframe",
      "timestamp",
      "open",
      "high",
      "low",
      "close",
      "volume",
    ])
    .where("source", "=", trainingCandleSeries.source)
    .where("product", "=", trainingCandleSeries.product)
    .where("timeframe", "=", trainingCandleSeries.timeframe)
    .where("asset", "=", asset)
    .orderBy("timestamp", "asc")
    .execute();

  return rows.map((row) => ({
    source: row.source,
    asset: row.asset,
    product: row.product,
    timeframe: row.timeframe,
    timestamp:
      row.timestamp instanceof Date ? row.timestamp : new Date(row.timestamp),
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
  }));
}
