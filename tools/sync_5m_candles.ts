#!/usr/bin/env bun
/**
 * Backfill 2 years of 5-minute candles into the wiggler Postgres database
 * from Coinbase (Advanced Trade public market data) and Binance (data-api).
 *
 * Page size is 288 candles = 1 day of 5-minute bars per request.
 *
 * Records per-page latency, per-series totals, and prints a summary at end.
 *
 * Requires DATABASE_URL (defaults to postgres://localhost:5432/wiggler).
 *
 * Usage:
 *   ./tools/sync_5m_candles.ts
 *   DAYS=730 ASSETS=btc,eth ./tools/sync_5m_candles.ts
 */

import { SQL } from "bun";

const DAYS = Number(process.env.DAYS ?? "730");
const PAGE_CANDLES = 288;
const PAGE_SECONDS = PAGE_CANDLES * 5 * 60; // 86400
const TIMEFRAME = "5m";
const ASSETS = (process.env.ASSETS ?? "btc,eth,sol,xrp,doge")
  .split(",")
  .map((a) => a.trim().toUpperCase())
  .filter(Boolean);

const NOW_SEC = Math.floor(Date.now() / 1000);
// align both ends to a 5-minute boundary; cap end at the most recently CLOSED bar
const END_SEC = Math.floor(NOW_SEC / 300) * 300;
const START_SEC = END_SEC - DAYS * 86400;

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://localhost:5432/wiggler";

type Source = "coinbase" | "binance";

type Candle = {
  source: Source;
  asset: string;
  exchange_pair: string;
  timeframe: string;
  open_time_ms: number;
  open_e8: bigint;
  high_e8: bigint;
  low_e8: bigint;
  close_e8: bigint;
  volume_e8: bigint;
  trades: number | null;
};

function toE8(s: string | number): bigint {
  const n = typeof s === "string" ? Number(s) : s;
  return BigInt(Math.round(n * 1e8));
}

async function withRetry<T>(label: string, fn: () => Promise<T>, max = 5): Promise<T> {
  let backoff = 500;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      if (attempt === max) throw e;
      const wait = e?.retryAfterMs ?? backoff;
      await Bun.sleep(wait);
      backoff = Math.min(backoff * 2, 10000);
    }
  }
  throw new Error(`unreachable: ${label}`);
}

async function fetchCoinbase(
  asset: string,
  startSec: number,
  endSec: number,
): Promise<Candle[]> {
  const product = `${asset}-USD`;
  const url = `https://api.coinbase.com/api/v3/brokerage/market/products/${product}/candles?start=${startSec}&end=${endSec}&granularity=FIVE_MINUTE`;
  const res = await fetch(url, { headers: { "User-Agent": "wiggler-sync/1.0" } });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after") ?? "1") * 1000;
      const err: any = new Error(`coinbase ${product} 429: ${body}`);
      err.retryAfterMs = ra;
      throw err;
    }
    throw new Error(`coinbase ${product} ${startSec}-${endSec}: ${res.status} ${body}`);
  }
  const data: any = await res.json();
  return (data.candles ?? []).map((c: any) => ({
    source: "coinbase" as const,
    asset,
    exchange_pair: product,
    timeframe: TIMEFRAME,
    open_time_ms: Number(c.start) * 1000,
    open_e8: toE8(c.open),
    high_e8: toE8(c.high),
    low_e8: toE8(c.low),
    close_e8: toE8(c.close),
    volume_e8: toE8(c.volume),
    trades: null,
  }));
}

async function fetchBinance(
  asset: string,
  startMs: number,
  endMs: number,
): Promise<Candle[]> {
  const symbol = `${asset}USDT`;
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=5m&startTime=${startMs}&endTime=${endMs}&limit=${PAGE_CANDLES}`;
  const res = await fetch(url, { headers: { "User-Agent": "wiggler-sync/1.0" } });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 429 || res.status === 418) {
      const ra = Number(res.headers.get("retry-after") ?? "5") * 1000;
      const err: any = new Error(`binance ${symbol} ${res.status}: ${body}`);
      err.retryAfterMs = ra;
      throw err;
    }
    throw new Error(`binance ${symbol} ${startMs}-${endMs}: ${res.status} ${body}`);
  }
  const rows: any[] = await res.json();
  return rows.map((r) => ({
    source: "binance" as const,
    asset,
    exchange_pair: symbol,
    timeframe: TIMEFRAME,
    open_time_ms: r[0],
    open_e8: toE8(r[1]),
    high_e8: toE8(r[2]),
    low_e8: toE8(r[3]),
    close_e8: toE8(r[4]),
    volume_e8: toE8(r[5]),
    trades: r[8] ?? null,
  }));
}

type SeriesResult = {
  source: Source;
  asset: string;
  pages: number;
  rowsFetched: number;
  rowsInserted: number;
  pageMs: number[];
  fetchTotalMs: number;
  insertMs: number;
};

async function syncSeries(sql: SQL, source: Source, asset: string): Promise<SeriesResult> {
  const all: Candle[] = [];
  const pageMs: number[] = [];
  let cursor = START_SEC;
  let fetchTotalMs = 0;

  while (cursor < END_SEC) {
    const pageEnd = Math.min(cursor + PAGE_SECONDS, END_SEC);
    const t0 = performance.now();
    const candles = await withRetry(`${source}/${asset} ${cursor}`, () => {
      if (source === "coinbase") {
        return fetchCoinbase(asset, cursor, pageEnd);
      }
      // Binance: startTime inclusive, endTime inclusive — subtract 1ms to avoid overlap
      return fetchBinance(asset, cursor * 1000, pageEnd * 1000 - 1);
    });
    const elapsed = performance.now() - t0;
    pageMs.push(elapsed);
    fetchTotalMs += elapsed;
    all.push(...candles);
    cursor = pageEnd;
  }

  // Bulk insert in chunks. Bun.sql supports `${sql(rows, ...cols)}` for INSERT VALUES.
  const t1 = performance.now();
  const CHUNK = 5000;
  const rows = all.map((c) => ({
    source: c.source,
    asset: c.asset,
    exchange_pair: c.exchange_pair,
    timeframe: c.timeframe,
    open_time: new Date(c.open_time_ms),
    open_time_ms: c.open_time_ms,
    open_e8: c.open_e8.toString(),
    high_e8: c.high_e8.toString(),
    low_e8: c.low_e8.toString(),
    close_e8: c.close_e8.toString(),
    volume_e8: c.volume_e8.toString(),
    trades: c.trades,
    fetched_at: new Date(),
    is_synthetic: false,
  }));
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const result = await sql`
      INSERT INTO candles ${sql(
        chunk,
        "source",
        "asset",
        "exchange_pair",
        "timeframe",
        "open_time",
        "open_time_ms",
        "open_e8",
        "high_e8",
        "low_e8",
        "close_e8",
        "volume_e8",
        "trades",
        "fetched_at",
        "is_synthetic",
      )}
      ON CONFLICT (source, asset, timeframe, open_time) DO NOTHING
    `;
    inserted += chunk.length;
  }
  const insertMs = performance.now() - t1;

  return {
    source,
    asset,
    pages: pageMs.length,
    rowsFetched: all.length,
    rowsInserted: inserted,
    pageMs,
    fetchTotalMs,
    insertMs,
  };
}

function pageStats(pageMs: number[]) {
  if (pageMs.length === 0) return { mean: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...pageMs].sort((a, b) => a - b);
  const mean = pageMs.reduce((a, b) => a + b, 0) / pageMs.length;
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const max = sorted[sorted.length - 1];
  return { mean, p50, p95, max };
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.floor(ms / 60000)}m${((ms % 60000) / 1000).toFixed(0)}s`;
}

async function main() {
  console.log(`fetching 5m candles, ${DAYS}d window: ${new Date(START_SEC * 1000).toISOString()} → ${new Date(END_SEC * 1000).toISOString()}`);
  console.log(`assets: ${ASSETS.join(",")}  page: ${PAGE_CANDLES} candles (${PAGE_SECONDS}s)\n`);

  const sql = new SQL(DATABASE_URL);
  const t_total_start = performance.now();
  const all: SeriesResult[] = [];

  for (const asset of ASSETS) {
    const t_asset = performance.now();
    console.log(`=== ${asset} ===`);
    // run binance + coinbase concurrently for this asset
    const [coinbase, binance] = await Promise.all([
      syncSeries(sql, "coinbase", asset),
      syncSeries(sql, "binance", asset),
    ]);
    const elapsed = performance.now() - t_asset;
    for (const r of [coinbase, binance]) {
      const s = pageStats(r.pageMs);
      console.log(
        `  ${r.source.padEnd(8)} pages=${r.pages.toString().padStart(3)} ` +
          `rows=${r.rowsFetched.toString().padStart(7)} ` +
          `fetch=${fmtMs(r.fetchTotalMs).padStart(7)} ` +
          `mean=${fmtMs(s.mean)} p50=${fmtMs(s.p50)} p95=${fmtMs(s.p95)} max=${fmtMs(s.max)} ` +
          `insert=${fmtMs(r.insertMs)}`,
      );
      all.push(r);
    }
    console.log(`  ${asset} total (concurrent): ${fmtMs(elapsed)}\n`);
  }

  const t_total = performance.now() - t_total_start;

  console.log("\n=== Summary ===");
  console.log(`${"asset".padEnd(6)} ${"source".padEnd(10)} ${"pages".padStart(5)} ${"rows".padStart(7)} ${"fetch".padStart(8)} ${"mean".padStart(7)} ${"p95".padStart(7)} ${"max".padStart(7)}`);
  for (const r of all) {
    const s = pageStats(r.pageMs);
    console.log(
      `${r.asset.padEnd(6)} ${r.source.padEnd(10)} ${r.pages.toString().padStart(5)} ${r.rowsFetched.toString().padStart(7)} ${fmtMs(r.fetchTotalMs).padStart(8)} ${fmtMs(s.mean).padStart(7)} ${fmtMs(s.p95).padStart(7)} ${fmtMs(s.max).padStart(7)}`,
    );
  }
  console.log(`\ntotal wall time: ${fmtMs(t_total)}  (rows fetched: ${all.reduce((a, r) => a + r.rowsFetched, 0)})`);

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
