import { trainingCandleSeries } from "@alea/constants/training";
import type { DatabaseClient } from "@alea/lib/db/types";
import type { Asset } from "@alea/types/assets";
import type { CandleTimeframe } from "@alea/types/candles";

/**
 * Returns the UNIX-ms timestamp of the most recent candle for one
 * `(asset, timeframe)` slice of the training series, or `null` if no
 * candles exist for that slice yet. Used as the freshness signal in
 * cache keys so a fresh sync invalidates the relevant entries
 * automatically.
 *
 * Cheap: indexed via the candles table's composite primary key on
 * `(source, asset, product, timeframe, timestamp)`, which lets Postgres
 * answer this with a single index probe rather than a full scan.
 */
export async function loadMaxCandleTimestamp({
  db,
  asset,
  timeframe = trainingCandleSeries.timeframe,
}: {
  readonly db: DatabaseClient;
  readonly asset: Asset;
  readonly timeframe?: CandleTimeframe;
}): Promise<number | null> {
  const row = await db
    .selectFrom("candles")
    .select((eb) => eb.fn.max("timestamp").as("maxTs"))
    .where("source", "=", trainingCandleSeries.source)
    .where("product", "=", trainingCandleSeries.product)
    .where("timeframe", "=", timeframe)
    .where("asset", "=", asset)
    .executeTakeFirst();
  const maxTs = row?.maxTs;
  if (maxTs === undefined || maxTs === null) {
    return null;
  }
  return maxTs instanceof Date ? maxTs.getTime() : new Date(maxTs).getTime();
}
