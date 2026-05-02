import { parseSyncCandlesArgs } from "@wiggler/bin/parseSyncCandlesArgs";
import { alignTimeframeWindow } from "@wiggler/lib/candles/alignTimeframeWindow";
import { summarizeSyncResult } from "@wiggler/lib/candles/summarizeSyncResult";
import { syncCandles, type SyncCandlesResult } from "@wiggler/lib/candles/syncCandles";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";

const millisecondsPerDay = 86_400_000;

/**
 * CLI handler for `candles:sync`. Resolves the time window, runs each
 * (source, asset) series sequentially, and prints per-series timing plus a
 * final summary.
 */
export async function runSyncCandles({
  argv,
}: {
  readonly argv: readonly string[];
}): Promise<void> {
  const { timeframe, lookbackDays, assets, sources } = parseSyncCandlesArgs({
    argv,
  });

  const end = alignTimeframeWindow({ date: new Date(), timeframe });
  const start = new Date(end.getTime() - lookbackDays * millisecondsPerDay);

  console.log(
    `wiggler candles:sync ${timeframe} ${start.toISOString()} → ${end.toISOString()}`,
  );
  console.log(`assets: ${assets.join(",")}  sources: ${sources.join(",")}`);
  console.log("");

  const db = createDatabase();
  const results: SyncCandlesResult[] = [];
  const overallStart = performance.now();

  try {
    for (const asset of assets) {
      console.log(`=== ${asset.toUpperCase()} ===`);
      for (const source of sources) {
        const result = await syncCandles({
          db,
          source,
          asset,
          timeframe,
          start,
          end,
        });
        results.push(result);
        const stats = summarizeSyncResult({ result });
        console.log(
          `  ${source.padEnd(8)} pages=${String(stats.count).padStart(4)} ` +
            `rows=${String(result.fetched).padStart(8)} ` +
            `fetch=${formatMs(result.fetchTotalMs).padStart(8)} ` +
            `mean=${formatMs(stats.meanMs)} ` +
            `p50=${formatMs(stats.p50Ms)} ` +
            `p95=${formatMs(stats.p95Ms)} ` +
            `max=${formatMs(stats.maxMs)} ` +
            `upsert=${formatMs(result.upsertTotalMs)}`,
        );
      }
      console.log("");
    }
  } finally {
    await destroyDatabase(db);
  }

  const overallMs = performance.now() - overallStart;
  const totalRows = results.reduce((sum, r) => sum + r.fetched, 0);
  console.log(
    `total wall time: ${formatMs(overallMs)}  rows=${totalRows}  series=${results.length}`,
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.floor(ms / 60_000)}m${((ms % 60_000) / 1000).toFixed(0)}s`;
}
