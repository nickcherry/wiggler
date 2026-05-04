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

  /**
   * Slope of the EMA-50 over the last 10 completed 5m bars, expressed
   * as the % change `(ema50_now − ema50_10ago) / ema50_10ago * 100`.
   * Positive = trend rising, negative = falling. Decoupled from the
   * price-vs-EMA filter — a flat trend can still have price above the
   * MA. `null` until 10 prior EMA-50 readings are available.
   */
  readonly ema50SlopePct: number | null;

  /**
   * 14-period RSI on 5m closes (Wilder's smoothing). Range 0–100, with
   * 50 the neutral midpoint. `null` until 14 prior closes are available.
   */
  readonly rsi14x5m: number | null;

  /**
   * Rate-of-change over the last 20 completed 5m bars, in percent:
   * `(close_now − close_20ago) / close_20ago * 100`. Sign indicates
   * direction; magnitude indicates momentum. `null` until 20 prior
   * closes are available.
   */
  readonly roc20Pct: number | null;

  /**
   * 14-period Average True Range on 5m bars. Wilder's smoothing on
   * `max(high−low, |high−prevClose|, |prevClose−low|)`. Used as a
   * volatility unit for stretch-from-mean and range-expansion filters.
   */
  readonly atr14x5m: number | null;

  /** 50-period ATR on 5m bars. Used for vol-regime comparison vs ATR-14. */
  readonly atr50x5m: number | null;

  /**
   * Highest high and lowest low across the last 50 completed 5m bars
   * — a Donchian channel. Used to position the current price within
   * its recent range. Both fields `null` until 50 prior bars exist.
   */
  readonly donchian50High: number | null;
  readonly donchian50Low: number | null;

  /**
   * The most recent COMPLETED 5m bar's OHLC (the one ending at the
   * start of the current window). Used by bar-shape filters
   * (body/range ratio, range expansion). `null` when no prior bar is
   * present in the loaded series.
   */
  readonly prev5mBar: {
    readonly open: number;
    readonly high: number;
    readonly low: number;
    readonly close: number;
  } | null;

  /**
   * The 5m bar BEFORE `prev5mBar` (i.e. two bars back). Used by
   * two-bar pattern filters such as inside-bar / bullish-engulfing.
   * `null` when fewer than two prior bars exist.
   */
  readonly prevPrev5mBar: {
    readonly open: number;
    readonly high: number;
    readonly low: number;
    readonly close: number;
  } | null;

  /**
   * Population standard deviation of 5m closes over the trailing 20
   * bars (same window as `ma20x5m`). Combined with `ma20x5m` this is
   * the basis for a Bollinger-band band-position filter. `null` until
   * 20 prior closes are available.
   */
  readonly bbStddev20x5m: number | null;

  /**
   * Directions of the ten most recent COMPLETED 5m bars, oldest first.
   * Used by majority-of-N-bars filters that look further back than
   * `last5x5mDirections`. `null` when fewer than ten prior bars exist.
   */
  readonly last10x5mDirections: readonly SurvivalSide[] | null;

  /**
   * Rate of change over the last 5 completed 5m bars, in percent.
   * Same shape as `roc20Pct` but a shorter lookback so we can compare
   * short- vs long-momentum (acceleration). `null` until 5 prior
   * closes are available.
   */
  readonly roc5Pct: number | null;

  /**
   * 14-period stochastic %K on 5m closes. Defined as
   * `(close - lowestLow_14) / (highestHigh_14 - lowestLow_14) * 100`.
   * Range 0–100. Different oscillator from RSI — measures position
   * within recent range rather than gain/loss balance. `null` when
   * fewer than 14 prior bars exist or the range is degenerate.
   */
  readonly stoch14x5m: number | null;

  /**
   * Volume of the most recent COMPLETED 5m bar (the same bar
   * `prev5mBar` describes). `null` when no prior bar is present.
   */
  readonly prev5mBarVolume: number | null;

  /**
   * Mean volume across the trailing 50 completed 5m bars. Used as
   * the baseline for spike / dryup tests against `prev5mBarVolume`.
   * `null` until 50 prior bars exist.
   */
  readonly avgVolume50x5m: number | null;

  /**
   * Average range (high − low) over the last 5 completed 5m bars
   * vs the 5 bars BEFORE that. Both null until 10 prior bars exist.
   * Used by range-decline / range-expansion-of-trend filters.
   */
  readonly avgRangeRecent5x5m: number | null;
  readonly avgRangePrior5x5m: number | null;

  /**
   * Highest high and lowest low across the trailing 50 completed
   * 5m bars (same as `donchian50High`/`Low`) PLUS the bar-index
   * offset at which each occurred (0 = most recent bar, 49 =
   * oldest). Lets filters ask "how recently did we last touch the
   * 50-bar extreme?" without storing the whole bar series.
   */
  readonly bars5mSinceDonchian50High: number | null;
  readonly bars5mSinceDonchian50Low: number | null;

  /**
   * Direction of the most recent COMPLETED 1m bar inside the
   * current 5m partial window — i.e. the candle the snapshot's
   * close came from. At remaining=4 this is window[0], at
   * remaining=1 it's window[3]. Always present (no warm-up
   * needed).
   */
  readonly currentMicroBarDirection: SurvivalSide;

  /**
   * Distance (in bp) from line to the *previous* 1m candle's close
   * within the current window. At remaining=4 there is no previous
   * 1m bar, so `null`. Compared against `snapshot.distanceBp` to
   * tell whether the side is decisively pulling away (distance
   * growing) or fading back (distance shrinking).
   */
  readonly prevMicroDistanceBp: number | null;
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
export const SNAPSHOT_PIPELINE_VERSION = 9;

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
    const ema50SlopePct =
      ma20Index?.ema50SlopePctAt({ windowStartMs }) ?? null;
    const rsi14x5m = ma20Index?.rsi14At({ windowStartMs }) ?? null;
    const roc20Pct = ma20Index?.roc20PctAt({ windowStartMs }) ?? null;
    const atr14x5m = ma20Index?.atrAt({ windowStartMs, period: 14 }) ?? null;
    const atr50x5m = ma20Index?.atrAt({ windowStartMs, period: 50 }) ?? null;
    const donchian50 =
      ma20Index?.donchianAt({ windowStartMs, period: 50 }) ?? null;
    const prev5mBar = ma20Index?.prevBarAt({ windowStartMs }) ?? null;
    const prevPrev5mBar = ma20Index?.prevPrevBarAt({ windowStartMs }) ?? null;
    const bbStddev20x5m =
      ma20Index?.stddevAt({ windowStartMs, period: 20 }) ?? null;
    const last10x5mDirections =
      ma20Index?.lastNDirectionsAt({ windowStartMs, n: 10 }) ?? null;
    const roc5Pct = ma20Index?.rocPctAt({ windowStartMs, period: 5 }) ?? null;
    const stoch14x5m =
      ma20Index?.stochKAt({ windowStartMs, period: 14 }) ?? null;
    const prev5mBarVolume =
      ma20Index?.prevBarVolumeAt({ windowStartMs }) ?? null;
    const avgVolume50x5m =
      ma20Index?.avgVolumeAt({ windowStartMs, period: 50 }) ?? null;
    const avgRangeRecent5x5m =
      ma20Index?.avgRangeAt({ windowStartMs, period: 5, offset: 0 }) ?? null;
    const avgRangePrior5x5m =
      ma20Index?.avgRangeAt({ windowStartMs, period: 5, offset: 5 }) ?? null;
    const donchianAge =
      ma20Index?.donchianAgeAt({ windowStartMs, period: 50 }) ?? null;
    const bars5mSinceDonchian50High = donchianAge?.barsSinceHigh ?? null;
    const bars5mSinceDonchian50Low = donchianAge?.barsSinceLow ?? null;
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

      // Per-snapshot 1m microstructure inside the partial 5m window.
      // The bar that produced this snapshot's close is window[candleIndex];
      // its direction is sign(close - open). For "distance growing"
      // tests we look at the 1m bar BEFORE this one (window[candleIndex-1])
      // — at remaining=4 that's null since we're on the first 1m bar.
      const currentMicroBarDirection: SurvivalSide =
        snapshotCandle.close >= snapshotCandle.open ? "up" : "down";
      let prevMicroDistanceBp: number | null = null;
      if (candleIndex > 0) {
        const prevMicroBar = window[candleIndex - 1];
        if (prevMicroBar !== undefined) {
          prevMicroDistanceBp = Math.floor(
            (Math.abs(prevMicroBar.close - line) / line) * 10000 + 1e-9,
          );
        }
      }

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
          ema50SlopePct,
          rsi14x5m,
          roc20Pct,
          atr14x5m,
          atr50x5m,
          donchian50High: donchian50?.high ?? null,
          donchian50Low: donchian50?.low ?? null,
          prev5mBar,
          prevPrev5mBar,
          bbStddev20x5m,
          last10x5mDirections,
          roc5Pct,
          stoch14x5m,
          prev5mBarVolume,
          avgVolume50x5m,
          avgRangeRecent5x5m,
          avgRangePrior5x5m,
          bars5mSinceDonchian50High,
          bars5mSinceDonchian50Low,
          currentMicroBarDirection,
          prevMicroDistanceBp,
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
 *   - `ema50SlopePctAt` — % change in EMA-50 over the last 10 bars.
 *   - `rsi14At` — 14-period Wilder RSI on closes.
 *   - `roc20PctAt` — 20-bar % rate of change.
 *   - `atrAt({ period })` — N-period Wilder ATR (14 and 50 supported).
 *   - `donchianAt({ period })` — N-bar high/low range (50 supported).
 *   - `prevBarAt` — OHLC of the most recent completed bar.
 *   - `lastThreeDirectionsAt` / `lastFiveDirectionsAt` — directions of the
 *     N most recent completed bars (oldest first).
 *
 * EMA convention: smoothing factor α = 2 / (N + 1), seeded with the SMA
 * of the first N closes and rolled forward thereafter. RSI + ATR use
 * Wilder smoothing (α = 1/N), seeded with simple averages over the
 * first N samples. All series indexed so `seriesAt[i]` = value computed
 * THROUGH AND INCLUDING bar i.
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
  readonly ema50SlopePctAt: (input: {
    readonly windowStartMs: number;
  }) => number | null;
  readonly rsi14At: (input: {
    readonly windowStartMs: number;
  }) => number | null;
  readonly roc20PctAt: (input: {
    readonly windowStartMs: number;
  }) => number | null;
  readonly atrAt: (input: {
    readonly windowStartMs: number;
    readonly period: 14 | 50;
  }) => number | null;
  readonly donchianAt: (input: {
    readonly windowStartMs: number;
    readonly period: 50;
  }) => { readonly high: number; readonly low: number } | null;
  readonly prevBarAt: (input: {
    readonly windowStartMs: number;
  }) => {
    readonly open: number;
    readonly high: number;
    readonly low: number;
    readonly close: number;
  } | null;
  readonly prevPrevBarAt: (input: {
    readonly windowStartMs: number;
  }) => {
    readonly open: number;
    readonly high: number;
    readonly low: number;
    readonly close: number;
  } | null;
  readonly stddevAt: (input: {
    readonly windowStartMs: number;
    readonly period: number;
  }) => number | null;
  readonly lastNDirectionsAt: (input: {
    readonly windowStartMs: number;
    readonly n: number;
  }) => readonly SurvivalSide[] | null;
  readonly rocPctAt: (input: {
    readonly windowStartMs: number;
    readonly period: number;
  }) => number | null;
  readonly stochKAt: (input: {
    readonly windowStartMs: number;
    readonly period: number;
  }) => number | null;
  readonly prevBarVolumeAt: (input: {
    readonly windowStartMs: number;
  }) => number | null;
  readonly avgVolumeAt: (input: {
    readonly windowStartMs: number;
    readonly period: number;
  }) => number | null;
  readonly avgRangeAt: (input: {
    readonly windowStartMs: number;
    readonly period: number;
    readonly offset: number;
  }) => number | null;
  readonly donchianAgeAt: (input: {
    readonly windowStartMs: number;
    readonly period: number;
  }) => {
    readonly barsSinceHigh: number;
    readonly barsSinceLow: number;
  } | null;
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

const EMA50_SLOPE_LOOKBACK = 10;
const ROC_PERIOD = 20;

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
  // search, per-index OHLC + direction arrays for bar-shape filters,
  // the running cumulative-close prefix sum used to answer SMAs in
  // O(1), and the per-index EMA arrays for the EMA periods we expose.
  const startTimes: number[] = [];
  const directions: SurvivalSide[] = [];
  const opens: number[] = [];
  const highs: number[] = [];
  const lows: number[] = [];
  const closes: number[] = [];
  const volumes: number[] = [];
  const cumulativeCloses: number[] = []; // cumulativeCloses[i] = Σ closes[0..i]
  const cumulativeVolumes: number[] = []; // O(1) trailing-volume averages
  const cumulativeRanges: number[] = []; // O(1) trailing-range averages
  let cumulative = 0;
  let cumulativeVol = 0;
  let cumulativeRange = 0;
  for (const candle of candles5m) {
    const startMs = candle.timestamp.getTime();
    const direction: SurvivalSide = candle.close >= candle.open ? "up" : "down";
    cumulative += candle.close;
    cumulativeVol += candle.volume;
    cumulativeRange += candle.high - candle.low;
    startTimes.push(startMs);
    directions.push(direction);
    opens.push(candle.open);
    highs.push(candle.high);
    lows.push(candle.low);
    closes.push(candle.close);
    volumes.push(candle.volume);
    cumulativeCloses.push(cumulative);
    cumulativeVolumes.push(cumulativeVol);
    cumulativeRanges.push(cumulativeRange);
  }

  const ema20 = computeEmaSeries({ closes, period: 20 });
  const ema50 = computeEmaSeries({ closes, period: 50 });
  const rsi14 = computeWilderRsiSeries({ closes, period: 14 });
  const atr14 = computeWilderAtrSeries({ highs, lows, closes, period: 14 });
  const atr50 = computeWilderAtrSeries({ highs, lows, closes, period: 50 });

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
      if (lastIdx < 0) {
        return null;
      }
      return ema20[lastIdx] ?? null;
    },
    ema50At: ({ windowStartMs }) => {
      const lastIdx = indexAtOrBefore(windowStartMs);
      if (lastIdx < 0) {
        return null;
      }
      return ema50[lastIdx] ?? null;
    },
    ema50SlopePctAt: ({ windowStartMs }) => {
      const lastIdx = indexAtOrBefore(windowStartMs);
      if (lastIdx < EMA50_SLOPE_LOOKBACK) {
        return null;
      }
      const now = ema50[lastIdx];
      const past = ema50[lastIdx - EMA50_SLOPE_LOOKBACK];
      if (now == null || past == null || past === 0) {
        return null;
      }
      return ((now - past) / past) * 100;
    },
    rsi14At: ({ windowStartMs }) => {
      const lastIdx = indexAtOrBefore(windowStartMs);
      if (lastIdx < 0) {
        return null;
      }
      return rsi14[lastIdx] ?? null;
    },
    roc20PctAt: ({ windowStartMs }) => {
      const lastIdx = indexAtOrBefore(windowStartMs);
      if (lastIdx < ROC_PERIOD) {
        return null;
      }
      const now = closes[lastIdx];
      const past = closes[lastIdx - ROC_PERIOD];
      if (now === undefined || past === undefined || past === 0) {
        return null;
      }
      return ((now - past) / past) * 100;
    },
    atrAt: ({ windowStartMs, period }) => {
      const lastIdx = indexAtOrBefore(windowStartMs);
      if (lastIdx < 0) {
        return null;
      }
      const series = period === 14 ? atr14 : atr50;
      return series[lastIdx] ?? null;
    },
    donchianAt: ({ windowStartMs, period }) => {
      const lastIdx = indexAtOrBefore(windowStartMs);
      if (lastIdx < period - 1) {
        return null;
      }
      let hi = -Infinity;
      let lo = Infinity;
      for (let k = lastIdx - period + 1; k <= lastIdx; k += 1) {
        const h = highs[k];
        const l = lows[k];
        if (h === undefined || l === undefined) {
          return null;
        }
        if (h > hi) {
          hi = h;
        }
        if (l < lo) {
          lo = l;
        }
      }
      return { high: hi, low: lo };
    },
    prevBarAt: ({ windowStartMs }) => {
      const lastIdx = indexAtOrBefore(windowStartMs);
      if (lastIdx < 0) {
        return null;
      }
      const o = opens[lastIdx];
      const h = highs[lastIdx];
      const l = lows[lastIdx];
      const c = closes[lastIdx];
      if (
        o === undefined ||
        h === undefined ||
        l === undefined ||
        c === undefined
      ) {
        return null;
      }
      return { open: o, high: h, low: l, close: c };
    },
    prevPrevBarAt: ({ windowStartMs }) => {
      const lastIdx = indexAtOrBefore(windowStartMs);
      if (lastIdx < 1) {
        return null;
      }
      const idx = lastIdx - 1;
      const o = opens[idx];
      const h = highs[idx];
      const l = lows[idx];
      const c = closes[idx];
      if (
        o === undefined ||
        h === undefined ||
        l === undefined ||
        c === undefined
      ) {
        return null;
      }
      return { open: o, high: h, low: l, close: c };
    },
    stddevAt: ({ windowStartMs, period }) => {
      const lastIdx = indexAtOrBefore(windowStartMs);
      if (lastIdx < period - 1) {
        return null;
      }
      const sum = sumOverWindow(lastIdx, period);
      if (sum === null) {
        return null;
      }
      const mean = sum / period;
      let sqDiffSum = 0;
      for (let k = lastIdx - period + 1; k <= lastIdx; k += 1) {
        const c = closes[k];
        if (c === undefined) {
          return null;
        }
        const d = c - mean;
        sqDiffSum += d * d;
      }
      return Math.sqrt(sqDiffSum / period);
    },
    lastNDirectionsAt: ({ windowStartMs, n }) => {
      const lastIdx = indexAtOrBefore(windowStartMs);
      return lastNDirections(lastIdx, n);
    },
    rocPctAt: ({ windowStartMs, period }) => {
      const lastIdx = indexAtOrBefore(windowStartMs);
      if (lastIdx < period) {
        return null;
      }
      const now = closes[lastIdx];
      const past = closes[lastIdx - period];
      if (now === undefined || past === undefined || past === 0) {
        return null;
      }
      return ((now - past) / past) * 100;
    },
    stochKAt: ({ windowStartMs, period }) => {
      const lastIdx = indexAtOrBefore(windowStartMs);
      if (lastIdx < period - 1) {
        return null;
      }
      let hi = -Infinity;
      let lo = Infinity;
      for (let k = lastIdx - period + 1; k <= lastIdx; k += 1) {
        const h = highs[k];
        const l = lows[k];
        if (h === undefined || l === undefined) {
          return null;
        }
        if (h > hi) {
          hi = h;
        }
        if (l < lo) {
          lo = l;
        }
      }
      const close = closes[lastIdx];
      if (close === undefined || hi === lo) {
        return null;
      }
      return ((close - lo) / (hi - lo)) * 100;
    },
    prevBarVolumeAt: ({ windowStartMs }) => {
      const lastIdx = indexAtOrBefore(windowStartMs);
      if (lastIdx < 0) {
        return null;
      }
      return volumes[lastIdx] ?? null;
    },
    avgVolumeAt: ({ windowStartMs, period }) => {
      const lastIdx = indexAtOrBefore(windowStartMs);
      if (lastIdx < period - 1) {
        return null;
      }
      const tail = cumulativeVolumes[lastIdx];
      const beforeHead =
        lastIdx - period >= 0 ? cumulativeVolumes[lastIdx - period] : 0;
      if (tail === undefined || beforeHead === undefined) {
        return null;
      }
      return (tail - beforeHead) / period;
    },
    avgRangeAt: ({ windowStartMs, period, offset }) => {
      const lastIdx = indexAtOrBefore(windowStartMs) - offset;
      if (lastIdx < period - 1) {
        return null;
      }
      const tail = cumulativeRanges[lastIdx];
      const beforeHead =
        lastIdx - period >= 0 ? cumulativeRanges[lastIdx - period] : 0;
      if (tail === undefined || beforeHead === undefined) {
        return null;
      }
      return (tail - beforeHead) / period;
    },
    donchianAgeAt: ({ windowStartMs, period }) => {
      const lastIdx = indexAtOrBefore(windowStartMs);
      if (lastIdx < period - 1) {
        return null;
      }
      let hi = -Infinity;
      let lo = Infinity;
      let hiIdx = -1;
      let loIdx = -1;
      for (let k = lastIdx - period + 1; k <= lastIdx; k += 1) {
        const h = highs[k];
        const l = lows[k];
        if (h === undefined || l === undefined) {
          return null;
        }
        if (h > hi) {
          hi = h;
          hiIdx = k;
        }
        if (l < lo) {
          lo = l;
          loIdx = k;
        }
      }
      return {
        barsSinceHigh: lastIdx - hiIdx,
        barsSinceLow: lastIdx - loIdx,
      };
    },
    lastThreeDirectionsAt: ({ windowStartMs }) => {
      const lastIdx = indexAtOrBefore(windowStartMs);
      const out = lastNDirections(lastIdx, 3);
      if (out === null) {
        return null;
      }
      const [a, b, c] = out;
      if (a === undefined || b === undefined || c === undefined) {
        return null;
      }
      return [a, b, c];
    },
    lastFiveDirectionsAt: ({ windowStartMs }) => {
      const lastIdx = indexAtOrBefore(windowStartMs);
      const out = lastNDirections(lastIdx, 5);
      if (out === null) {
        return null;
      }
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

/**
 * Wilder RSI series: `out[i]` is the N-period RSI computed through and
 * including `closes[i]`. Implementation follows the canonical Wilder
 * smoothing: average gains and losses over the first N intervals
 * (using diff between consecutive closes), then roll forward with
 * `avg = ((N-1)*avg_prev + current) / N`. RSI = 100 − 100/(1 + RS)
 * where RS = avgGain / avgLoss. The first usable index is `period`
 * (need N price diffs); earlier indices are `null`.
 */
function computeWilderRsiSeries({
  closes,
  period,
}: {
  readonly closes: readonly number[];
  readonly period: number;
}): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(closes.length).fill(
    null,
  );
  if (closes.length <= period) {
    return out;
  }
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const a = closes[i - 1];
    const b = closes[i];
    if (a === undefined || b === undefined) {
      return out;
    }
    const diff = b - a;
    if (diff >= 0) {
      gainSum += diff;
    } else {
      lossSum -= diff;
    }
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = rsiOf({ avgGain, avgLoss });
  for (let i = period + 1; i < closes.length; i += 1) {
    const a = closes[i - 1];
    const b = closes[i];
    if (a === undefined || b === undefined) {
      continue;
    }
    const diff = b - a;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiOf({ avgGain, avgLoss });
  }
  return out;
}

function rsiOf({
  avgGain,
  avgLoss,
}: {
  readonly avgGain: number;
  readonly avgLoss: number;
}): number {
  if (avgLoss === 0) {
    return 100;
  }
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Wilder ATR series. True range per bar i:
 *   TR_i = max(high_i − low_i, |high_i − close_{i-1}|, |close_{i-1} − low_i|)
 * The ATR series uses Wilder smoothing seeded with the simple average
 * of the first N true ranges, then `atr_i = ((N-1)·atr_{i-1} + TR_i) / N`.
 * `out[i]` is the ATR through and including bar i; first usable index
 * is `period - 1` (need N bars to seed). Indices before that are `null`.
 */
function computeWilderAtrSeries({
  highs,
  lows,
  closes,
  period,
}: {
  readonly highs: readonly number[];
  readonly lows: readonly number[];
  readonly closes: readonly number[];
  readonly period: number;
}): (number | null)[] {
  const n = closes.length;
  const out: (number | null)[] = new Array<number | null>(n).fill(null);
  if (n < period) {
    return out;
  }
  // True range per bar; bar 0's TR is just high − low (no prior close).
  const tr: number[] = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    const h = highs[i];
    const l = lows[i];
    if (h === undefined || l === undefined) {
      return out;
    }
    if (i === 0) {
      tr[i] = h - l;
      continue;
    }
    const prevClose = closes[i - 1];
    if (prevClose === undefined) {
      return out;
    }
    tr[i] = Math.max(
      h - l,
      Math.abs(h - prevClose),
      Math.abs(prevClose - l),
    );
  }
  // Seed with simple average of first `period` TR values.
  let sum = 0;
  for (let i = 0; i < period; i += 1) {
    const v = tr[i];
    if (v === undefined) {
      return out;
    }
    sum += v;
  }
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < n; i += 1) {
    const v = tr[i];
    if (v === undefined) {
      continue;
    }
    prev = (prev * (period - 1) + v) / period;
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
