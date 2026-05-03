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
   * Direction of the 1m candle immediately before the snapshot's 1m
   * candle. `null` when that candle isn't present in the input series
   * (e.g. snapshot at +1m of the very first window).
   */
  readonly prev1mDirection: SurvivalSide | null;

  /**
   * Direction of the 5m candle that ended at the start of the current
   * window — derived from the five 1m candles immediately preceding this
   * window. `null` when those five candles aren't all present.
   */
  readonly prev5mDirection: SurvivalSide | null;

  /**
   * Closing price of the 5m candle that ended at the start of the current
   * window. Constant across all four snapshots in the window. Useful for
   * comparing line vs MA, etc.
   */
  readonly prev5mClose: number | null;

  /**
   * Directions of the three 1m candles immediately before the snapshot's
   * 1m candle, oldest first. `null` when fewer than three preceding 1m
   * candles are present.
   */
  readonly last3x1mDirections:
    | readonly [SurvivalSide, SurvivalSide, SurvivalSide]
    | null;

  /**
   * 20-period simple moving average of 5m closes, evaluated *before* the
   * current 5m window starts. `null` when fewer than 20 prior 5m closes
   * are available. Source: the separate 5m candle series passed to
   * `computeSurvivalSnapshots`, joined to each window by `windowStartMs`.
   */
  readonly ma20x5m: number | null;
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
export const SNAPSHOT_PIPELINE_VERSION = 1;

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

    const prev5mClose = ma20Index?.prevCloseAt({ windowStartMs }) ?? null;
    const prev5mDirection =
      ma20Index?.prevDirectionAt({ windowStartMs }) ?? null;
    const ma20x5m = ma20Index?.maAt({ windowStartMs }) ?? null;

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

      // The 1m candle whose direction is the snapshot's "previous 1m"
      // sits at series index `idx + candleIndex - 1`. Negative indices
      // mean the lookback isn't available yet.
      const prev1mDirection = directionAt({
        candles: candles1m,
        index: idx + candleIndex - 1,
      });

      const last3x1mDirections = lastThreeDirectionsAt({
        candles: candles1m,
        snapshotIndex: idx + candleIndex,
      });

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
          prev1mDirection,
          prev5mDirection,
          prev5mClose,
          last3x1mDirections,
          ma20x5m,
        },
      };
    }
  }
}

/**
 * Iterates non-overlapping 5m windows of 1m candles plus the start index
 * of each window in the source array. The index is needed by the snapshot
 * pipeline so it can read 1m candles before the window starts (for the
 * `prev1m` and `last3x1m` lookbacks).
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

function directionAt({
  candles,
  index,
}: {
  readonly candles: readonly Candle[];
  readonly index: number;
}): SurvivalSide | null {
  if (index < 0 || index >= candles.length) {
    return null;
  }
  const candle = candles[index];
  if (candle === undefined) {
    return null;
  }
  return candle.close >= candle.open ? "up" : "down";
}

function lastThreeDirectionsAt({
  candles,
  snapshotIndex,
}: {
  readonly candles: readonly Candle[];
  /**
   * The series index of the snapshot's own 1m candle. The "last three"
   * are the candles at indices `snapshotIndex - 3`, `snapshotIndex - 2`,
   * `snapshotIndex - 1`.
   */
  readonly snapshotIndex: number;
}): readonly [SurvivalSide, SurvivalSide, SurvivalSide] | null {
  const a = directionAt({ candles, index: snapshotIndex - 3 });
  const b = directionAt({ candles, index: snapshotIndex - 2 });
  const c = directionAt({ candles, index: snapshotIndex - 1 });
  if (a === null || b === null || c === null) {
    return null;
  }
  return [a, b, c];
}

/**
 * Precomputed 5m-context index for fast lookups by `windowStartMs`. The
 * MA-20 at a given window is the SMA of the 20 closing prices of the 5m
 * candles ending strictly before that window starts. The previous-5m
 * direction and close are the close-vs-open and close of the 5m candle
 * that ended at exactly `windowStartMs`.
 */
type FiveMinuteIndex = {
  readonly maAt: (input: { readonly windowStartMs: number }) => number | null;
  readonly prevDirectionAt: (input: {
    readonly windowStartMs: number;
  }) => SurvivalSide | null;
  readonly prevCloseAt: (input: {
    readonly windowStartMs: number;
  }) => number | null;
};

const MA20_PERIOD = 20;

function build5mLookback({
  candles5m,
}: {
  readonly candles5m: readonly Candle[] | undefined;
}): FiveMinuteIndex | null {
  if (candles5m === undefined || candles5m.length === 0) {
    return null;
  }
  const byEndMs = new Map<
    number,
    { readonly direction: SurvivalSide; readonly close: number }
  >();
  // Single O(n) pass over the 5m series (already sorted ascending by the
  // loader): build the prev-5m direction/close lookup, the chronological
  // start-time array for binary search, and the running cumulative-close
  // prefix sum used to answer MA-20 in O(1).
  const startTimes: number[] = [];
  const closeAtStart = new Map<number, number>();
  let cumulative = 0;
  for (const candle of candles5m) {
    const startMs = candle.timestamp.getTime();
    const endMs = startMs + MS_PER_5M;
    byEndMs.set(endMs, {
      direction: candle.close >= candle.open ? "up" : "down",
      close: candle.close,
    });
    cumulative += candle.close;
    startTimes.push(startMs);
    closeAtStart.set(startMs, cumulative);
  }

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

  return {
    maAt: ({ windowStartMs }) => {
      // We need the 20 most recent 5m candles whose start time is strictly
      // less than `windowStartMs`. Find the index of the latest such
      // candle, then take the 20-sample window ending there.
      const lastIdx = indexAtOrBefore(windowStartMs);
      if (lastIdx < MA20_PERIOD - 1) {
        return null;
      }
      const tail = closeAtStart.get(startTimes[lastIdx] ?? -1);
      const beforeHead = closeAtStart.get(
        startTimes[lastIdx - MA20_PERIOD] ?? -1,
      );
      if (tail === undefined) {
        return null;
      }
      const sum = tail - (beforeHead ?? 0);
      return sum / MA20_PERIOD;
    },
    prevDirectionAt: ({ windowStartMs }) => {
      return byEndMs.get(windowStartMs)?.direction ?? null;
    },
    prevCloseAt: ({ windowStartMs }) => {
      return byEndMs.get(windowStartMs)?.close ?? null;
    },
  };
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
