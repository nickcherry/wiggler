import { trainingCandleSeries } from "@alea/constants/training";
import type { DatabaseClient } from "@alea/lib/db/types";
import type { Asset } from "@alea/types/assets";
import type { Candle, CandleTimeframe } from "@alea/types/candles";

/**
 * Reads every candle for one asset out of the local Postgres, filtered to
 * the training domain's `(source, product)` pair (see
 * `src/constants/training.ts`) at the requested timeframe. Rows come back
 * ascending by timestamp so downstream code can rely on chronological order
 * without an extra sort.
 *
 * Defaults to the canonical training timeframe (5m); pass `timeframe: "1m"`
 * for the survival analysis, which needs intra-window snapshots.
 *
 * No paging — for one asset on 1m bars over a few-year backfill we are
 * looking at ~1–2M rows, which fits comfortably in memory.
 */
export async function loadTrainingCandles({
  db,
  asset,
  timeframe = trainingCandleSeries.timeframe,
}: {
  readonly db: DatabaseClient;
  readonly asset: Asset;
  readonly timeframe?: CandleTimeframe;
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
    .where("timeframe", "=", timeframe)
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
