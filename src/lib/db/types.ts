import type { CandleTimeframe } from "@alea/types/candles";
import type { Product } from "@alea/types/products";
import type { CandleSource } from "@alea/types/sources";
import type { ColumnType, Generated, Kysely } from "kysely";

export type DatabaseTimestamp = ColumnType<Date, Date | string, Date | string>;

/**
 * Canonical candle row persisted in PostgreSQL. Sources can disagree on the
 * same `(asset, product, timeframe, timestamp)` so source is part of the
 * primary key. Product distinguishes the spot vs perp market on the same
 * asset (which trade at a small funding-rate basis to each other).
 */
export interface CandleTable {
  readonly source: CandleSource;
  readonly asset: string;
  readonly product: Product;
  readonly timeframe: CandleTimeframe;
  readonly timestamp: DatabaseTimestamp;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/**
 * Append-only market-data tape. See migration
 * `202605051400_create_market_event.ts` for the rationale; in short,
 * one row per WS-emitted event with the level/trade payload as JSONB
 * so book updates aren't normalised into a row-per-level explosion.
 *
 * Column names are snake_case to match the Kysely setup (no
 * camel-case conversion plugin is installed). `bigint` columns
 * (`ts_ms`, `received_ms`) come back from `pg` as strings by default —
 * `ColumnType` lets us declare the read-side as `string` and the
 * write-side as `string | number | bigint` so callers can pass
 * `Date.now()` directly without manual coercion.
 */
export interface MarketEventTable {
  readonly id: Generated<string>;
  readonly ts_ms: ColumnType<string, string | number | bigint, never>;
  readonly received_ms: ColumnType<string, string | number | bigint, never>;
  readonly source: string;
  readonly asset: string | null;
  readonly kind: string;
  readonly market_ref: string | null;
  readonly payload: unknown;
}

export interface Database {
  readonly candles: CandleTable;
  readonly market_event: MarketEventTable;
}

export type DatabaseClient = Kysely<Database>;
