import { binanceInterval } from "@alea/lib/candles/sources/binance/binanceInterval";
import { binancePerpSymbol } from "@alea/lib/candles/sources/binance/binancePerpSymbol";
import type { Asset } from "@alea/types/assets";
import type { Candle, CandleTimeframe } from "@alea/types/candles";

/**
 * Binance USDT-margined perpetual klines published as zip archives on
 * Binance Vision. We use this in place of the live `fapi.binance.com` REST
 * endpoint because that host is geo-blocked from the US (HTTP 451).
 *
 * Vision publishes two granularities: a monthly zip for each fully-completed
 * UTC month, and a daily zip for each fully-completed UTC day. For an
 * arbitrary `[start, end)` window we want every candle in that range, so the
 * fetcher decomposes the window into UTC-days and routes each day to:
 *
 *   - the monthly archive if that day's month has fully closed,
 *   - the daily archive if the day is in the current month but already
 *     completed,
 *   - no archive if the day is today (Vision hasn't published it yet).
 *
 * Files are downloaded at most once per process via an in-memory cache so a
 * page-driven sync (which steps day-by-day) doesn't re-download the same
 * monthly archive 30 times.
 */
const baseUrl = "https://data.binance.vision/data/futures/um";

/**
 * Up to ~120 distinct archives could be touched across a full 5-asset sync,
 * but only a handful are active at any moment. 32 leaves headroom for several
 * concurrent perp-series fetches without thrashing.
 */
const cacheCap = 32;
const fileCache = new Map<string, Promise<readonly Candle[]>>();

const oneDayMs = 86_400_000;

type FetchBinancePerpCandlesParams = {
  readonly asset: Asset;
  readonly timeframe: CandleTimeframe;
  readonly start: Date;
  readonly end: Date;
};

/**
 * Returns validated perpetual-swap candles whose open-time falls in
 * `[start, end)`. Internally pulls whichever Vision archives overlap the
 * window, caching parsed files so adjacent pages don't re-download.
 */
export async function fetchBinancePerpCandles({
  asset,
  timeframe,
  start,
  end,
}: FetchBinancePerpCandlesParams): Promise<readonly Candle[]> {
  const startMs = start.getTime();
  const endMs = end.getTime();
  if (endMs <= startMs) {
    return [];
  }
  const symbol = binancePerpSymbol({ asset });
  const interval = binanceInterval({ timeframe });
  const todayUtc = utcDayStart(new Date());
  const dayStarts = enumerateDayStarts({ startMs, endMs });
  const archiveSpecs = new Map<string, ArchiveSpec>();

  for (const dayStart of dayStarts) {
    if (dayStart >= todayUtc) {
      continue;
    }
    const spec = chooseArchive({ dayStart, todayUtc, symbol, interval });
    archiveSpecs.set(spec.url, spec);
  }

  const perFile = await Promise.all(
    [...archiveSpecs.values()].map((spec) =>
      loadArchive({ spec, asset, timeframe }),
    ),
  );
  const combined: Candle[] = [];
  for (const candles of perFile) {
    for (const candle of candles) {
      const ts = candle.timestamp.getTime();
      if (ts >= startMs && ts < endMs) {
        combined.push(candle);
      }
    }
  }
  combined.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return combined;
}

type ArchiveSpec = {
  readonly url: string;
  readonly granularity: "monthly" | "daily";
};

function chooseArchive({
  dayStart,
  todayUtc,
  symbol,
  interval,
}: {
  readonly dayStart: number;
  readonly todayUtc: number;
  readonly symbol: string;
  readonly interval: "1m" | "5m";
}): ArchiveSpec {
  const day = new Date(dayStart);
  const monthEnd = Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 1);
  if (monthEnd <= todayUtc) {
    const month = formatMonth({ date: day });
    return {
      url: `${baseUrl}/monthly/klines/${symbol}/${interval}/${symbol}-${interval}-${month}.zip`,
      granularity: "monthly",
    };
  }
  const date = formatDate({ date: day });
  return {
    url: `${baseUrl}/daily/klines/${symbol}/${interval}/${symbol}-${interval}-${date}.zip`,
    granularity: "daily",
  };
}

async function loadArchive({
  spec,
  asset,
  timeframe,
}: {
  readonly spec: ArchiveSpec;
  readonly asset: Asset;
  readonly timeframe: CandleTimeframe;
}): Promise<readonly Candle[]> {
  const cached = fileCache.get(spec.url);
  if (cached !== undefined) {
    fileCache.delete(spec.url);
    fileCache.set(spec.url, cached);
    return cached;
  }
  const promise = downloadAndParse({ spec, asset, timeframe });
  fileCache.set(spec.url, promise);
  while (fileCache.size > cacheCap) {
    const oldest = fileCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    fileCache.delete(oldest);
  }
  return promise;
}

async function downloadAndParse({
  spec,
  asset,
  timeframe,
}: {
  readonly spec: ArchiveSpec;
  readonly asset: Asset;
  readonly timeframe: CandleTimeframe;
}): Promise<readonly Candle[]> {
  const response = await fetch(spec.url, {
    headers: { "User-Agent": "alea/1.0" },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new BinancePerpFetchError({
      message: `Binance Vision ${spec.granularity} ${spec.url} failed: ${response.status} ${body}`,
      status: response.status,
    });
  }
  const zipBytes = Buffer.from(await response.arrayBuffer());
  const csv = await unzipFirstMember(zipBytes);
  return parseKlinesCsv({ csv, asset, timeframe });
}

/**
 * Pipes a zip archive's bytes through `funzip` (bundled with macOS/Linux's
 * `unzip` package) to extract the first member's contents. Avoids touching
 * disk and avoids pulling in a JS zip dependency.
 */
async function unzipFirstMember(zip: Buffer): Promise<string> {
  const proc = Bun.spawn(["funzip"], {
    stdin: zip,
    stdout: "pipe",
    stderr: "pipe",
  });
  const csv = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`funzip exited ${exitCode}: ${stderr}`);
  }
  return csv;
}

function parseKlinesCsv({
  csv,
  asset,
  timeframe,
}: {
  readonly csv: string;
  readonly asset: Asset;
  readonly timeframe: CandleTimeframe;
}): readonly Candle[] {
  const candles: Candle[] = [];
  let cursor = 0;
  let isFirstLine = true;
  while (cursor < csv.length) {
    const newlineIndex = csv.indexOf("\n", cursor);
    const lineEnd = newlineIndex === -1 ? csv.length : newlineIndex;
    const line = csv.slice(cursor, lineEnd).trimEnd();
    cursor = lineEnd + 1;
    if (line.length === 0) {
      continue;
    }
    if (isFirstLine) {
      isFirstLine = false;
      const firstCellEnd = line.indexOf(",");
      const firstCell =
        firstCellEnd === -1 ? line : line.slice(0, firstCellEnd);
      if (!/^\d/.test(firstCell)) {
        continue;
      }
    }
    const cells = line.split(",");
    if (cells.length < 6) {
      continue;
    }
    const openTimeMs = Number(cells[0]);
    if (!Number.isFinite(openTimeMs)) {
      continue;
    }
    candles.push({
      source: "binance",
      asset,
      product: "perp",
      timeframe,
      timestamp: new Date(openTimeMs),
      open: Number(cells[1]),
      high: Number(cells[2]),
      low: Number(cells[3]),
      close: Number(cells[4]),
      volume: Number(cells[5]),
    });
  }
  return candles;
}

function enumerateDayStarts({
  startMs,
  endMs,
}: {
  readonly startMs: number;
  readonly endMs: number;
}): readonly number[] {
  const days: number[] = [];
  let cursor = utcDayStart(new Date(startMs));
  while (cursor < endMs) {
    days.push(cursor);
    cursor += oneDayMs;
  }
  return days;
}

function utcDayStart(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function formatMonth({ date }: { readonly date: Date }): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

function formatDate({ date }: { readonly date: Date }): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export class BinancePerpFetchError extends Error {
  readonly status: number;

  constructor({
    message,
    status,
  }: {
    readonly message: string;
    readonly status: number;
  }) {
    super(message);
    this.name = "BinancePerpFetchError";
    this.status = status;
  }
}
