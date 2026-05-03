import { candlesPerFetchPage } from "@wiggler/constants/candles";
import {
  type CandleGapRange,
  findCandleGaps,
} from "@wiggler/lib/candles/findCandleGaps";
import { fetchCandlesPage } from "@wiggler/lib/candles/sources/fetchCandlesPage";
import { timeframeMs } from "@wiggler/lib/candles/timeframeMs";
import { upsertCandles } from "@wiggler/lib/candles/upsertCandles";
import type { DatabaseClient } from "@wiggler/lib/db/types";
import type { Asset } from "@wiggler/types/assets";
import type { CandleTimeframe } from "@wiggler/types/candles";
import type { Product } from "@wiggler/types/products";
import type { CandleSource } from "@wiggler/types/sources";

type FillCandleGapsParams = {
  readonly db: DatabaseClient;
  readonly source: CandleSource;
  readonly asset: Asset;
  readonly product: Product;
  readonly timeframe: CandleTimeframe;
};

export type FillCandleGapsResult = {
  readonly source: CandleSource;
  readonly asset: Asset;
  readonly product: Product;
  readonly timeframe: CandleTimeframe;
  readonly gaps: readonly CandleGapRange[];
  readonly missingBars: number;
  readonly recoveredBars: number;
  readonly elapsedMs: number;
};

/**
 * Identifies missing 5-min bars in the persisted series and re-queries the
 * source for each gap range, upserting whatever the API returns now. Some
 * exchange outage gaps are eventually backfilled by the venue and become
 * recoverable on a later pull; ones that never get backfilled remain
 * missing.
 *
 * Each gap range is fetched as one page (or chunked into `candlesPerFetchPage`
 * sub-pages for the rare gap longer than that limit) and upserted before the
 * next range, so partial progress is durable.
 */
export async function fillCandleGaps({
  db,
  source,
  asset,
  product,
  timeframe,
}: FillCandleGapsParams): Promise<FillCandleGapsResult> {
  const barMs = timeframeMs({ timeframe });
  const chunkMs = barMs * candlesPerFetchPage;
  const overallStart = performance.now();
  const gaps = await findCandleGaps({ db, source, asset, product, timeframe });
  const missingBars = gaps.reduce((sum, gap) => sum + gap.bars, 0);
  let recoveredBars = 0;

  for (const gap of gaps) {
    let cursor = gap.startMs;
    while (cursor < gap.endMs) {
      const chunkEnd = Math.min(cursor + chunkMs, gap.endMs);
      const candles = await fetchCandlesPage({
        source,
        asset,
        product,
        timeframe,
        start: new Date(cursor),
        end: new Date(chunkEnd),
      });
      // Coinbase treats `end` as inclusive and may return one bar past the
      // requested window. Only count bars that genuinely fell inside this
      // gap chunk as recovered.
      const inChunk = candles.filter((c) => {
        const ts = c.timestamp.getTime();
        return ts >= cursor && ts < chunkEnd;
      });
      if (inChunk.length > 0) {
        await upsertCandles({ db, candles: inChunk });
        recoveredBars += inChunk.length;
      }
      cursor = chunkEnd;
    }
  }

  return {
    source,
    asset,
    product,
    timeframe,
    gaps,
    missingBars,
    recoveredBars,
    elapsedMs: performance.now() - overallStart,
  };
}
