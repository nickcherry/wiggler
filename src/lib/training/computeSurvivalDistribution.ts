import type {
  AssetSurvivalDistribution,
  SurvivalBucket,
  SurvivalRemainingMinutes,
  SurvivalSurface,
  SurvivalSurfaceWithCount,
} from "@alea/lib/training/types";
import type { Asset } from "@alea/types/assets";
import type { Candle } from "@alea/types/candles";

/**
 * Snapshot indices inside a 5m window of 1m candles. A window is five
 * consecutive 1m candles `[c0, c1, c2, c3, c4]` covering minutes
 * `[+0..+1, +1..+2, +2..+3, +3..+4, +4..+5]`. The "snapshot at +Nm" uses
 * the close of `c_{N-1}` — the price as of the moment +Nm into the window
 * — so:
 *
 *   - snapshot at +1m (4m left) → close of c0
 *   - snapshot at +2m (3m left) → close of c1
 *   - snapshot at +3m (2m left) → close of c2
 *   - snapshot at +4m (1m left) → close of c3
 *
 * The line is `c0.open` and the final price is `c4.close`.
 */
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
 * Computes the baseline "point of no return" survival surface for one
 * asset: for each `(remainingMinutes, distanceBp)` bucket, how often did
 * the side currently leading at that snapshot end the 5m window on the
 * same side?
 *
 * Conventions:
 *   - line price = open of the first 1m candle in the 5m window
 *   - final price = close of the last (5th) 1m candle in the window
 *   - snapshot price = close of the just-completed 1m candle at +Nm
 *   - side = `price >= line ? UP : DOWN` (ties favor UP)
 *   - distanceBp = floor(|snapshotPrice - line| / line * 10000)
 *
 * Windows missing any of their five 1m candles, or whose first candle has
 * a non-positive open, are skipped — no interpolation, no partial credit.
 *
 * Returns `null` when no usable windows exist.
 */
export function computeSurvivalDistribution({
  asset,
  candles,
}: {
  readonly asset: Asset;
  readonly candles: readonly Candle[];
}): AssetSurvivalDistribution | null {
  const allRaw = createRawSurface();
  const byYearRaw = new Map<string, RawSurface>();
  let windowCount = 0;
  const yearWindowCounts = new Map<string, number>();

  for (const [c0, c1, c2, c3, c4] of iterateWindows(candles)) {
    if (c0.open <= 0) {
      continue;
    }
    const line = c0.open;
    const finalSide = sideOf({ price: c4.close, line });
    const year = String(c0.timestamp.getUTCFullYear());
    const yearRaw = byYearRaw.get(year) ?? createRawSurface();
    const snapshotCloses = [c0.close, c1.close, c2.close, c3.close] as const;

    for (const { candleIndex, remaining } of SNAPSHOTS) {
      const price = snapshotCloses[candleIndex];
      const currentSide = sideOf({ price, line });
      const survived = currentSide === finalSide;
      // Half-open `[N, N+1)` bp buckets. The +1e-9 tolerates float slop
      // at integer ticks: `(100.05 - 100) / 100 * 10000` yields 4.99…
      // because 0.05 isn't representable, and we want that to land in
      // bucket 5, not bucket 4.
      const distanceBp = Math.floor(
        (Math.abs(price - line) / line) * 10000 + 1e-9,
      );
      record({ raw: allRaw, remaining, distanceBp, survived });
      record({ raw: yearRaw, remaining, distanceBp, survived });
    }

    byYearRaw.set(year, yearRaw);
    windowCount += 1;
    yearWindowCounts.set(year, (yearWindowCounts.get(year) ?? 0) + 1);
  }

  if (windowCount === 0) {
    return null;
  }

  return {
    asset,
    windowCount,
    all: materializeSurface({ raw: allRaw }),
    byYear: buildYearBreakdown({ byYearRaw, yearWindowCounts }),
  };
}

/**
 * Iterates non-overlapping 5m windows of 1m candles. A window starts on a
 * UTC 5-minute boundary; the iterator emits a window only when all five
 * expected 1m candles are present (no gaps), so the consumer can index
 * `[0..4]` without bounds checks. Input candles must be sorted ascending
 * by timestamp (the loader guarantees this).
 */
function* iterateWindows(
  candles: readonly Candle[],
): Generator<readonly [Candle, Candle, Candle, Candle, Candle]> {
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
      // Unreachable given the loop guard but the type-checker can't see
      // that. Bail safely if it ever happens.
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
    yield [c0, c1, c2, c3, c4] as const;
    i += 5;
  }
}

type RawBucket = { total: number; survived: number };
type RawSurface = Record<SurvivalRemainingMinutes, Map<number, RawBucket>>;

function createRawSurface(): RawSurface {
  return {
    1: new Map(),
    2: new Map(),
    3: new Map(),
    4: new Map(),
  };
}

function record({
  raw,
  remaining,
  distanceBp,
  survived,
}: {
  readonly raw: RawSurface;
  readonly remaining: SurvivalRemainingMinutes;
  readonly distanceBp: number;
  readonly survived: boolean;
}): void {
  const bucket = raw[remaining].get(distanceBp) ?? { total: 0, survived: 0 };
  bucket.total += 1;
  if (survived) {
    bucket.survived += 1;
  }
  raw[remaining].set(distanceBp, bucket);
}

function materializeSurface({
  raw,
}: {
  readonly raw: RawSurface;
}): SurvivalSurface {
  return {
    byRemaining: {
      1: bucketsOf({ map: raw[1] }),
      2: bucketsOf({ map: raw[2] }),
      3: bucketsOf({ map: raw[3] }),
      4: bucketsOf({ map: raw[4] }),
    },
  };
}

function bucketsOf({
  map,
}: {
  readonly map: ReadonlyMap<number, RawBucket>;
}): readonly SurvivalBucket[] {
  const distances = [...map.keys()].sort((a, b) => a - b);
  return distances.map((distanceBp) => {
    const bucket = map.get(distanceBp);
    if (bucket === undefined) {
      throw new Error("unreachable: distance key without bucket");
    }
    return {
      distanceBp,
      total: bucket.total,
      survived: bucket.survived,
    };
  });
}

function buildYearBreakdown({
  byYearRaw,
  yearWindowCounts,
}: {
  readonly byYearRaw: ReadonlyMap<string, RawSurface>;
  readonly yearWindowCounts: ReadonlyMap<string, number>;
}): Record<string, SurvivalSurfaceWithCount> {
  const out: Record<string, SurvivalSurfaceWithCount> = {};
  const years = [...byYearRaw.keys()].sort();
  for (const year of years) {
    const raw = byYearRaw.get(year);
    const count = yearWindowCounts.get(year);
    if (raw === undefined || count === undefined || count === 0) {
      continue;
    }
    out[year] = {
      windowCount: count,
      ...materializeSurface({ raw }),
    };
  }
  return out;
}

function sideOf({
  price,
  line,
}: {
  readonly price: number;
  readonly line: number;
}): "up" | "down" {
  return price >= line ? "up" : "down";
}
