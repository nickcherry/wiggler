import type { CandleTimeframe } from "@wiggler/types/candles";
import type { CandleSource } from "@wiggler/types/sources";
import type { ColumnType, Kysely } from "kysely";

export type DatabaseTimestamp = ColumnType<Date, Date | string, Date | string>;

/**
 * Canonical candle row persisted in PostgreSQL. Sources can disagree on the
 * same `(asset, timeframe, timestamp)` so source is part of the primary key.
 */
export interface CandleTable {
  readonly source: CandleSource;
  readonly asset: string;
  readonly timeframe: CandleTimeframe;
  readonly timestamp: DatabaseTimestamp;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface Database {
  readonly candles: CandleTable;
}

export type DatabaseClient = Kysely<Database>;
