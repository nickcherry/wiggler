import {
  computeSurvivalSnapshots,
  type SurvivalRemainingMinutes,
  type SurvivalSnapshot,
} from "@alea/lib/training/computeSurvivalSnapshots";
import type {
  AssetSurvivalDistribution,
  SurvivalBucket,
  SurvivalSurface,
  SurvivalSurfaceWithCount,
} from "@alea/lib/training/types";
import type { Asset } from "@alea/types/assets";
import type { Candle } from "@alea/types/candles";

/**
 * Computes the baseline "point of no return" survival surface for one
 * asset. Delegates the per-snapshot work to `computeSurvivalSnapshots` —
 * which produces the same `(line, finalSide, snapshotPrice, distanceBp,
 * remaining, survived, ...)` tuples the filter framework consumes — and
 * folds them into the historical-only `byRemaining + byYear` shape the
 * baseline dashboard section reads.
 *
 * Conventions (shared with the filter framework):
 *   - line price = open of the first 1m candle in the 5m window
 *   - final price = close of the last (5th) 1m candle in the window
 *   - snapshot price = close of the just-completed 1m candle at +Nm
 *   - side = `price >= line ? UP : DOWN` (ties favor UP)
 *   - distanceBp = floor(|snapshotPrice - line| / line * 10000) (with a
 *     small float-slop tolerance at integer ticks)
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
  const allWindows = new Set<number>();
  const yearWindows = new Map<string, Set<number>>();

  for (const snapshot of computeSurvivalSnapshots({ candles1m: candles })) {
    accumulate({ raw: allRaw, snapshot });
    allWindows.add(snapshot.windowStartMs);
    const yearRaw = byYearRaw.get(snapshot.year) ?? createRawSurface();
    accumulate({ raw: yearRaw, snapshot });
    byYearRaw.set(snapshot.year, yearRaw);
    const yearWindowSet = yearWindows.get(snapshot.year) ?? new Set<number>();
    yearWindowSet.add(snapshot.windowStartMs);
    yearWindows.set(snapshot.year, yearWindowSet);
  }

  if (allWindows.size === 0) {
    return null;
  }

  return {
    asset,
    windowCount: allWindows.size,
    all: materializeSurface({ raw: allRaw }),
    byYear: buildYearBreakdown({ byYearRaw, yearWindows }),
  };
}

function accumulate({
  raw,
  snapshot,
}: {
  readonly raw: RawSurface;
  readonly snapshot: SurvivalSnapshot;
}): void {
  const bucket = raw[snapshot.remaining].get(snapshot.distanceBp) ?? {
    total: 0,
    survived: 0,
  };
  bucket.total += 1;
  if (snapshot.survived) {
    bucket.survived += 1;
  }
  raw[snapshot.remaining].set(snapshot.distanceBp, bucket);
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
  yearWindows,
}: {
  readonly byYearRaw: ReadonlyMap<string, RawSurface>;
  readonly yearWindows: ReadonlyMap<string, ReadonlySet<number>>;
}): Record<string, SurvivalSurfaceWithCount> {
  const out: Record<string, SurvivalSurfaceWithCount> = {};
  const years = [...byYearRaw.keys()].sort();
  for (const year of years) {
    const raw = byYearRaw.get(year);
    const windows = yearWindows.get(year);
    if (raw === undefined || windows === undefined || windows.size === 0) {
      continue;
    }
    out[year] = {
      windowCount: windows.size,
      ...materializeSurface({ raw }),
    };
  }
  return out;
}
