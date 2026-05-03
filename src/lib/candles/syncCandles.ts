import { candlesPerFetchPage } from "@wiggler/constants/candles";
import { fetchCandlesPage } from "@wiggler/lib/candles/sources/fetchCandlesPage";
import { timeframeMs } from "@wiggler/lib/candles/timeframeMs";
import { upsertCandles } from "@wiggler/lib/candles/upsertCandles";
import type { DatabaseClient } from "@wiggler/lib/db/types";
import type { Asset } from "@wiggler/types/assets";
import type { CandleTimeframe } from "@wiggler/types/candles";
import type { Product } from "@wiggler/types/products";
import type { CandleSource } from "@wiggler/types/sources";

type SyncCandlesParams = {
  readonly db: DatabaseClient;
  readonly source: CandleSource;
  readonly asset: Asset;
  readonly product: Product;
  readonly timeframe: CandleTimeframe;
  readonly start: Date;
  readonly end: Date;
};

export type SyncCandlesPageMetric = {
  readonly start: Date;
  readonly end: Date;
  readonly fetched: number;
  readonly elapsedMs: number;
};

export type SyncCandlesResult = {
  readonly source: CandleSource;
  readonly asset: Asset;
  readonly product: Product;
  readonly timeframe: CandleTimeframe;
  readonly start: Date;
  readonly end: Date;
  readonly pages: readonly SyncCandlesPageMetric[];
  readonly fetched: number;
  readonly persisted: number;
  readonly fetchTotalMs: number;
  readonly upsertTotalMs: number;
};

/**
 * Pages through `[start, end)` for one (source, asset, product, timeframe)
 * series, fetching `candlesPerFetchPage` candles per call. Each page is
 * upserted before the next is fetched so a long sync can be interrupted
 * without losing all progress. Per-page latency is recorded for the caller.
 */
export async function syncCandles({
  db,
  source,
  asset,
  product,
  timeframe,
  start,
  end,
}: SyncCandlesParams): Promise<SyncCandlesResult> {
  const barMs = timeframeMs({ timeframe });
  const pageMs = barMs * candlesPerFetchPage;
  const pages: SyncCandlesPageMetric[] = [];
  let fetched = 0;
  let persisted = 0;
  let fetchTotalMs = 0;
  let upsertTotalMs = 0;

  let cursorMs = start.getTime();
  const endMs = end.getTime();

  while (cursorMs < endMs) {
    const pageEndMs = Math.min(cursorMs + pageMs, endMs);
    const pageStart = new Date(cursorMs);
    const pageEnd = new Date(pageEndMs);

    const fetchStart = performance.now();
    const candles = await fetchCandlesPage({
      source,
      asset,
      product,
      timeframe,
      start: pageStart,
      end: pageEnd,
    });
    const fetchElapsed = performance.now() - fetchStart;

    const upsertStart = performance.now();
    await upsertCandles({ db, candles });
    upsertTotalMs += performance.now() - upsertStart;

    pages.push({
      start: pageStart,
      end: pageEnd,
      fetched: candles.length,
      elapsedMs: fetchElapsed,
    });
    fetched += candles.length;
    persisted += candles.length;
    fetchTotalMs += fetchElapsed;

    cursorMs = pageEndMs;
  }

  return {
    source,
    asset,
    product,
    timeframe,
    start,
    end,
    pages,
    fetched,
    persisted,
    fetchTotalMs,
    upsertTotalMs,
  };
}

