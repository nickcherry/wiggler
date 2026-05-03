import type { Database } from "@alea/lib/db/types";
import { type Kysely, sql } from "kysely";

/**
 * Creates the canonical multi-source candle storage table. Composite primary
 * key on (source, asset, product, timeframe, timestamp) lets the same
 * asset/timeframe be tracked from multiple exchanges and across spot vs perp
 * markets without collisions.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("candles")
    .addColumn("source", "text", (column) => column.notNull())
    .addColumn("asset", "text", (column) => column.notNull())
    .addColumn("product", "text", (column) => column.notNull())
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
      "product",
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

  await sql`
    alter table candles
    add constraint candles_product_check
    check (product in ('spot', 'perp'))
  `.execute(db);

  // Cross-source lookup: "what does the cluster of venues think happened
  // at this asset/product/timeframe at this instant". The PK already covers
  // single-source queries.
  await db.schema
    .createIndex("candles_asset_product_timeframe_timestamp_idx")
    .on("candles")
    .columns(["asset", "product", "timeframe", "timestamp"])
    .execute();

  // Range scans by time across all assets/products/sources at a given
  // timeframe — useful for any "give me everything in this window" query.
  await db.schema
    .createIndex("candles_timeframe_timestamp_idx")
    .on("candles")
    .columns(["timeframe", "timestamp"])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("candles").ifExists().execute();
}
