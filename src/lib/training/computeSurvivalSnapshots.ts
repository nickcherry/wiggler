import type { SurvivalRemainingMinutes } from "@alea/lib/training/types";
import type { Candle } from "@alea/types/candles";

/**
 * One in-window observation: the `(remainingMinutes, distanceBp)` pair the
 * baseline survival surface buckets, plus enough lookback context that
 * binary filters can classify it without re-iterating the source series.
 *
 * All snapshots in the same 5m window share `windowStartMs`, `line`,
 * `finalPrice`, and `finalSide`; the per-snapshot fields are the snapshot
 * close, current side, distance, and contextual lookbacks.
 */
export type SurvivalSnapshot = {
  readonly windowStartMs: number;
  readonly year: string;
  readonly line: number;
  readonly finalPrice: number;
  readonly finalSide: SurvivalSide;
  readonly snapshotPrice: number;
  readonly currentSide: SurvivalSide;
  readonly distanceBp: number;
  readonly remaining: SurvivalRemainingMinutes;
  readonly survived: boolean;
  readonly context: SurvivalSnapshotContext;
};

export type { SurvivalRemainingMinutes };

export type SurvivalSide = "up" | "down";

/**
 * Per-snapshot lookback context. Fields are nullable so a filter can
 * decide for itself whether missing context counts as "skip" or as the
 * "false" bucket. Keeping the missing-data signal here, not at the filter
 * boundary, lets each filter make its own call.
 */
export type SurvivalSnapshotContext = {
  /**
   * Directions of the three most recent COMPLETED 5m bars, oldest first.
   * For a window `[0:10, 0:15)`, this is the bars covering `[-0:05, 0:00)`,
   * `[0:00, 0:05)`, `[0:05, 0:10)`. Constant across the window's four
   * snapshots. `null` when any of those three bars isn't present.
   */
  readonly last3x5mDirections:
    | readonly [SurvivalSide, SurvivalSide, SurvivalSide]
    | null;

  /**
   * Directions of the five most recent COMPLETED 5m bars, oldest first.
   * Same semantics as `last3x5mDirections` but two more bars deep.
   * `null` when any of the five required bars isn't present.
   */
  readonly last5x5mDirections:
    | readonly [
        SurvivalSide,
        SurvivalSide,
        SurvivalSide,
        SurvivalSide,
        SurvivalSide,
      ]
    | null;

  /**
   * 20-period simple moving average of 5m closes, evaluated *before* the
   * current 5m window starts. `null` when fewer than 20 prior 5m closes
   * are available. Source: the separate 5m candle series passed to
   * `computeSurvivalSnapshots`, joined to each window by `windowStartMs`.
   */
  readonly ma20x5m: number | null;

  /** 50-period simple moving average of 5m closes; same semantics as `ma20x5m`. */
  readonly ma50x5m: number | null;

  /**
   * 20-period exponential moving average of 5m closes, evaluated
   * *before* the current 5m window starts. EMA uses the conventional
   * smoothing factor α = 2 / (period + 1), seeded with the SMA of the
   * first `period` closes and rolled forward thereafter. `null` until
   * the seed is available.
   */
  readonly ema20x5m: number | null;

  /** 50-period EMA of 5m closes; same semantics as `ema20x5m`. */
  readonly ema50x5m: number | null;
};

const SNAPSHOTS: readonly {
  readonly candleIndex: 0 | 1 | 2 | 3;
  readonly remaining: SurvivalRemainingMinutes;
}[] = [
  { candleIndex: 0, remaining: 4 },
  { candleIndex: 1, remaining: 3 },
  { candleIndex: 2, remaining: 2 },
  { candleIndex: 3, remaining: 1 },
];

const MS_PER_5M = 5 * 60 * 1000;
const MS_PER_1M = 60 * 1000;

/**
 * Bumps when the snapshot enumeration's externally-visible behaviour
 * changes — e.g. distance bucketing, a new context field, the side
 * tie-breaker convention. Caches keyed by this value are invalidated on
 * any bump, so don't rev it for non-semantic refactors. Standalone export
 * so cache callers don't need to know the file's internals.
 */
export const SNAPSHOT_PIPELINE_VERSION = 5;

/**
 * Walks the 1m candle series, emitting one `SurvivalSnapshot` per usable
 * `(window, +Nm)` pair. A "usable" window is five gap-free 1m candles
 * starting on a UTC 5-minute boundary, with a strictly positive line
 * (open of the first candle).
 *
 * The 5m candle series is optional but recommended: it powers the
 * `ma20x5m` and (more reliably than 1m-derived heuristics) `prev5m`
 * context fields. When omitted, those fields are always `null` and the
 * MA-alignment filter will skip every snapshot.
 *
 * Output is in chronological order (window start ascending, then
 * remaining-minutes 4 → 1).
 */
export function* computeSurvivalSnapshots({
  candles1m,
  candles5m,
}: {
  readonly candles1m: readonly Candle[];
  readonly candles5m?: readonly Candle[];
}): Generator<SurvivalSnapshot> {
  const ma20Index = build5mLookback({ candles5m });

  for (const { idx, window } of iterateWindows(candles1m)) {
    const c0 = window[0];
    const c4 = window[4];
    if (c0.open <= 0) {
      continue;
    }
    const line = c0.open;
    const finalPrice = c4.close;
    const finalSide = sideOf({ price: finalPrice, line });
    const year = String(c0.timestamp.getUTCFullYear());
    const windowStartMs = c0.timestamp.getTime();

    // All 5m context fields are constant across the window's four
    // snapshots — the most recent completed 5m bars (and the SMAs/EMAs
    // computed off them) don't change inside the current window.
    const last3x5mDirections =
      ma20Index?.lastThreeDirectionsAt({ windowStartMs }) ?? null;
    const last5x5mDirections =
      ma20Index?.lastFiveDirectionsAt({ windowStartMs }) ?? null;
    const ma20x5m = ma20Index?.smaAt({ windowStartMs, period: 20 }) ?? null;
    const ma50x5m = ma20Index?.smaAt({ windowStartMs, period: 50 }) ?? null;
    const ema20x5m = ma20Index?.ema20At({ windowStartMs }) ?? null;
    const ema50x5m = ma20Index?.ema50At({ windowStartMs }) ?? null;
    // `idx` is currently only consumed by the dropped 1m lookbacks,
    // but the iterator still needs it for callers that may want it
    // back; keep it referenced so the type-checker doesn't complain
    // and so future filters can hang per-snapshot lookups off it
    // without re-plumbing.
    void idx;

    for (const { candleIndex, remaining } of SNAPSHOTS) {
      const snapshotCandle = window[candleIndex];
      const snapshotPrice = snapshotCandle.close;
      const currentSide = sideOf({ price: snapshotPrice, line });
      const survived = currentSide === finalSide;
      // Half-open `[N, N+1)` bp buckets. The +1e-9 tolerates float slop
      // at integer ticks: `(100.05 - 100) / 100 * 10000` yields 4.99…
      // because 0.05 isn't representable, and we want that to land in
      // bucket 5, not bucket 4.
      const distanceBp = Math.floor(
        (Math.abs(snapshotPrice - line) / line) * 10000 + 1e-9,
      );

      yield {
        windowStartMs,
        year,
        line,
        finalPrice,
        finalSide,
        snapshotPrice,
        currentSide,
        distanceBp,
        remaining,
        survived,
        context: {
          last3x5mDirections,
          last5x5mDirections,
          ma20x5m,
          ma50x5m,
          ema20x5m,
          ema50x5m,
        },
      };
    }
  }
}

/**
 * Iterates non-overlapping 5m windows of 1m candles plus the start index
 * of each window in the source array. The index is currently unused by
 * the snapshot pipeline (all context is 5m-derived) but the iterator
 * keeps emitting it so future per-snapshot lookbacks can reuse it
 * without re-plumbing the iterator surface.
 */
function* iterateWindows(candles: readonly Candle[]): Generator<{
  readonly idx: number;
  readonly window: readonly [Candle, Candle, Candle, Candle, Candle];
}> {
  let i = 0;
  while (i + 4 < candles.length) {
    const c0 = candles[i];
    const c1 = candles[i + 1];
    const c2 = candles[i + 2];
    const c3 = candles[i + 3];
    const c4 = candles[i + 4];
    if (
      c0 === undefined ||
      c1 === undefined ||
      c2 === undefined ||
      c3 === undefined ||
      c4 === undefined
    ) {
      break;
    }
    const startMs = c0.timestamp.getTime();
    if (startMs % MS_PER_5M !== 0) {
      i += 1;
      continue;
    }
    if (
      c1.timestamp.getTime() !== startMs + MS_PER_1M ||
      c2.timestamp.getTime() !== startMs + 2 * MS_PER_1M ||
      c3.timestamp.getTime() !== startMs + 3 * MS_PER_1M ||
      c4.timestamp.getTime() !== startMs + 4 * MS_PER_1M
    ) {
      i += 1;
      continue;
    }
    yield { idx: i, window: [c0, c1, c2, c3, c4] as const };
    i += 5;
  }
}

/**
 * Precomputed 5m-context index for fast lookups by `windowStartMs`. All
 * lookups use "the most recent COMPLETED 5m bar before windowStart" as
 * their reference point, so the data they read never leaks the future.
 *
 *   - `smaAt({ period })` — N-period SMA of close prices (O(1) via prefix sum).
 *   - `ema20At` / `ema50At` — N-period EMA, precomputed per-index (O(1) lookup).
 *   - `lastThreeDirectionsAt` / `lastFiveDirectionsAt` — directions of the
 *     N most recent completed bars (oldest first).
 *
 * EMA convention: smoothing factor α = 2 / (N + 1), seeded with the SMA
 * of the first N closes and rolled forward thereafter. EMA value at
 * index `i` represents the EMA computed THROUGH AND INCLUDING bar `i`.
 */
type FiveMinuteIndex = {
  readonly smaAt: (input: {
    readonly windowStartMs: number;
    readonly period: number;
  }) => number | null;
  readonly ema20At: (input: {
    readonly windowStartMs: number;
  }) => number | null;
  readonly ema50At: (input: {
    readonly windowStartMs: number;
  }) => number | null;
  readonly lastThreeDirectionsAt: (input: {
    readonly windowStartMs: number;
  }) => readonly [SurvivalSide, SurvivalSide, SurvivalSide] | null;
  readonly lastFiveDirectionsAt: (input: {
    readonly windowStartMs: number;
  }) =>
    | readonly [
        SurvivalSide,
        SurvivalSide,
        SurvivalSide,
        SurvivalSide,
        SurvivalSide,
      ]
    | null;
};

function build5mLookback({
  candles5m,
}: {
  readonly candles5m: readonly Candle[] | undefined;
}): FiveMinuteIndex | null {
  if (candles5m === undefined || candles5m.length === 0) {
    return null;
  }
  // Single O(n) pass over the 5m series (already sorted ascending by
  // the loader): build the chronological start-time array for binary
  // search, the per-index direction array for last-N lookups, the
  // running cumulative-close prefix sum used to answer SMAs in O(1),
  // and the per-index EMA arrays for the EMA periods we expose.
  const startTimes: number[] = [];
  const directions: SurvivalSide[] = [];
  const closes: number[] = [];
  const cumulativeCloses: number[] = []; // cumulativeCloses[i] = Σ closes[0..i]
  let cumulative = 0;
  for (const candle of candles5m) {
    const startMs = candle.timestamp.getTime();
    const direction: SurvivalSide = candle.close >= candle.open ? "up" : "down";
    cumulative += candle.close;
    startTimes.push(startMs);
    directions.push(direction);
    closes.push(candle.close);
    cumulativeCloses.push(cumulative);
  }

  const ema20 = computeEmaSeries({ closes, period: 20 });
  const ema50 = computeEmaSeries({ closes, period: 50 });

  const indexAtOrBefore = (target: number): number => {
    let lo = 0;
    let hi = startTimes.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = startTimes[mid];
      if (t === undefined) {
        break;
      }
      if (t < target) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  };

  // Sum of closes[lastIdx-period+1 .. lastIdx], the SMA-period window
  // ending at lastIdx, computed in O(1) from the cumulative prefix sum.
  const sumOverWindow = (lastIdx: number, period: number): number | null => {
    if (lastIdx < period - 1) {
      return null;
    }
    const tail = cumulativeCloses[lastIdx];
    const beforeHead =
      lastIdx - period >= 0 ? cumulativeCloses[lastIdx - period] : 0;
    if (tail === undefined || beforeHead === undefined) {
      return null;
    }
    return tail - beforeHead;
  };

  const lastNDirections = (
    lastIdx: number,
    n: number,
  ): readonly SurvivalSide[] | null => {
    if (lastIdx < n - 1) {
      return null;
    }
    const out: SurvivalSide[] = [];
    for (let k = n - 1; k >= 0; k -= 1) {
      const d = directions[lastIdx - k];
      if (d === undefined) {
        return null;
      }
      out.push(d);
    }
    return out;
  };

  return {
    smaAt: ({ windowStartMs, period }) => {
      const lastIdx = indexAtOrBefore(windowStartMs);
      const sum = sumOverWindow(lastIdx, period);
      return sum === null ? null : sum / period;
    },
    ema20At: ({ windowStartMs }) => {
      const lastIdx = indexAtOrBefore(windowStartMs);
      if (lastIdx < 0) {return null;}
      return ema20[lastIdx] ?? null;
    },
    ema50At: ({ windowStartMs }) => {
      const lastIdx = indexAtOrBefore(windowStartMs);
      if (lastIdx < 0) {return null;}
      return ema50[lastIdx] ?? null;
    },
    lastThreeDirectionsAt: ({ windowStartMs }) => {
      const lastIdx = indexAtOrBefore(windowStartMs);
      const out = lastNDirections(lastIdx, 3);
      if (out === null) {return null;}
      const [a, b, c] = out;
      if (a === undefined || b === undefined || c === undefined) {return null;}
      return [a, b, c];
    },
    lastFiveDirectionsAt: ({ windowStartMs }) => {
      const lastIdx = indexAtOrBefore(windowStartMs);
      const out = lastNDirections(lastIdx, 5);
      if (out === null) {return null;}
      const [a, b, c, d, e] = out;
      if (
        a === undefined ||
        b === undefined ||
        c === undefined ||
        d === undefined ||
        e === undefined
      ) {
        return null;
      }
      return [a, b, c, d, e];
    },
  };
}

/**
 * EMA series: `out[i]` is the N-period EMA computed through and
 * including `closes[i]`. Seeds at index `period - 1` with the SMA of
 * `closes[0..period-1]`, then rolls forward with the standard
 * recurrence `EMA_t = α · close_t + (1 − α) · EMA_{t-1}` where
 * `α = 2 / (N + 1)`. Indices before the seed are `null` (warm-up).
 */
function computeEmaSeries({
  closes,
  period,
}: {
  readonly closes: readonly number[];
  readonly period: number;
}): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(closes.length).fill(
    null,
  );
  if (closes.length < period) {
    return out;
  }
  let seedSum = 0;
  for (let i = 0; i < period; i += 1) {
    const c = closes[i];
    if (c === undefined) {
      return out;
    }
    seedSum += c;
  }
  const alpha = 2 / (period + 1);
  let prev = seedSum / period;
  out[period - 1] = prev;
  for (let i = period; i < closes.length; i += 1) {
    const c = closes[i];
    if (c === undefined) {
      continue;
    }
    prev = alpha * c + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

function sideOf({
  price,
  line,
}: {
  readonly price: number;
  readonly line: number;
}): SurvivalSide {
  return price >= line ? "up" : "down";
}
