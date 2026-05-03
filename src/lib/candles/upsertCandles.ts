import type { DatabaseClient } from "@wiggler/lib/db/types";
import type { Candle } from "@wiggler/types/candles";
import { sql } from "kysely";

/**
 * Postgres caps a single statement at 65535 parameters. With 9 columns per
 * candle we keep batches well under that ceiling.
 */
const upsertBatchSize = 1000;

/**
 * Upserts validated candles in bounded batches, updating OHLCV on conflict so
 * occasional vendor corrections propagate forward.
 */
export async function upsertCandles({
  db,
  candles,
}: {
  readonly db: DatabaseClient;
  readonly candles: readonly Candle[];
}): Promise<void> {
  if (candles.length === 0) {
    return;
  }

  for (let start = 0; start < candles.length; start += upsertBatchSize) {
    const batch = candles.slice(start, start + upsertBatchSize);

    await db
      .insertInto("candles")
      .values(
        batch.map((candle) => ({
          source: candle.source,
          asset: candle.asset,
          product: candle.product,
          timeframe: candle.timeframe,
          timestamp: candle.timestamp,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
        })),
      )
      .onConflict((conflict) =>
        conflict
          .columns(["source", "asset", "product", "timeframe", "timestamp"])
          .doUpdateSet({
            open: sql`excluded.open`,
            high: sql`excluded.high`,
            low: sql`excluded.low`,
            close: sql`excluded.close`,
            volume: sql`excluded.volume`,
          }),
      )
      .execute();
  }
}
