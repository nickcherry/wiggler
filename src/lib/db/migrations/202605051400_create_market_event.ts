import type { Database } from "@alea/lib/db/types";
import { type Kysely, sql } from "kysely";

/**
 * Append-only firehose of every market-data event we capture from
 * external venues. Used as a tape archive for offline replay/research:
 * the trading runner does NOT read from this table, only the data
 * pipeline writes to it.
 *
 * Design choices:
 *   - One row per *event*, not per book level. Book payload (full
 *     L2 levels, asks + bids) is JSONB. Normalising would explode
 *     row count for ~no benefit.
 *   - `id` is a synthetic bigserial because the natural identity of
 *     an event is the (source, asset, ts_ms, kind, payload-hash)
 *     tuple — too wide to be a useful primary key. Re-ingesting the
 *     same JSONL twice is therefore mildly idempotent (caller-side
 *     responsibility), not DB-enforced.
 *   - Indexed lookups: by time, by (source, asset, time), and by
 *     market_ref (for "what was Polymarket book X at this instant").
 *     `asset` is nullable for venue-level events (e.g. WS connect /
 *     disconnect markers) that don't belong to a single asset.
 *   - `received_ms` separate from `ts_ms` so we can spot venue clock
 *     skew and inter-venue latency in research.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("market_event")
    .addColumn("id", "bigserial", (column) => column.primaryKey())
    .addColumn("ts_ms", "bigint", (column) => column.notNull())
    .addColumn("received_ms", "bigint", (column) => column.notNull())
    .addColumn("source", "text", (column) => column.notNull())
    .addColumn("asset", "text")
    .addColumn("kind", "text", (column) => column.notNull())
    .addColumn("market_ref", "text")
    .addColumn("payload", "jsonb", (column) => column.notNull())
    .execute();

  await db.schema
    .createIndex("market_event_ts_ms_idx")
    .on("market_event")
    .columns(["ts_ms"])
    .execute();

  await db.schema
    .createIndex("market_event_source_asset_ts_ms_idx")
    .on("market_event")
    .columns(["source", "asset", "ts_ms"])
    .execute();

  // Partial index — `market_ref` is null for crypto venue events but
  // present for every Polymarket event. Filtering keeps the index
  // small and makes "what was Polymarket market X at time T" lookups
  // fast.
  await sql`
    create index market_event_market_ref_ts_ms_idx
    on market_event (market_ref, ts_ms)
    where market_ref is not null
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("market_event").ifExists().execute();
}
