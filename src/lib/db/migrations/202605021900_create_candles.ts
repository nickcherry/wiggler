import type { Database } from "@wiggler/lib/db/types";
import { type Kysely, sql } from "kysely";

/**
 * Creates the canonical multi-source candle storage table. Composite primary
 * key on (source, asset, timeframe, timestamp) lets the same asset/timeframe
 * be tracked from multiple exchanges without collisions.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("candles")
    .addColumn("source", "text", (column) => column.notNull())
    .addColumn("asset", "text", (column) => column.notNull())
    .addColumn("timeframe", "text", (column) => column.notNull())
    .addColumn("timestamp", "timestamptz", (column) => column.notNull())
    .addColumn("open", "double precision", (column) => column.notNull())
    .addColumn("high", "double precision", (column) => column.notNull())
    .addColumn("low", "double precision", (column) => column.notNull())
    .addColumn("close", "double precision", (column) => column.notNull())
    .addColumn("volume", "double precision", (column) => column.notNull())
    .addPrimaryKeyConstraint("candles_pkey", [
      "source",
      "asset",
      "timeframe",
      "timestamp",
    ])
    .execute();

  await sql`
    alter table candles
    add constraint candles_timeframe_check
    check (timeframe in ('1m', '5m'))
  `.execute(db);

  await sql`
    alter table candles
    add constraint candles_source_check
    check (source in ('coinbase', 'binance'))
  `.execute(db);

  await db.schema
    .createIndex("candles_asset_timeframe_timestamp_idx")
    .on("candles")
    .columns(["asset", "timeframe", "timestamp"])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("candles").ifExists().execute();
}
