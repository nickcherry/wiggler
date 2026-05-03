/**
 * Linear-interpolation percentile (numpy default `linear`). For an array of
 * `n` ascending-sorted values:
 *
 *   - `p = 0`   → the minimum
 *   - `p = 100` → the maximum
 *   - `p = 50`  → the median
 *   - other `p` → interpolates between the two surrounding ranks
 *
 * The fractional rank is `(p / 100) * (n - 1)`. This is the same convention
 * pandas and numpy use, which keeps memory of "p% of observations are at or
 * below this value" intact even between sample points.
 */
export function computePercentile({
  sortedValues,
  p,
}: {
  readonly sortedValues: readonly number[];
  readonly p: number;
}): number {
  if (sortedValues.length === 0) {
    throw new Error("computePercentile: sortedValues must be non-empty");
  }
  if (p < 0 || p > 100) {
    throw new Error(`computePercentile: p must be in [0, 100]; got ${p}`);
  }
  const n = sortedValues.length;
  const rank = (p / 100) * (n - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const lowerValue = sortedValues[lower];
  const upperValue = sortedValues[upper];
  if (lowerValue === undefined || upperValue === undefined) {
    throw new Error(
      `computePercentile: index out of range (lower=${lower} upper=${upper} n=${n})`,
    );
  }
  if (lower === upper) {
    return lowerValue;
  }
  const weight = rank - lower;
  return lowerValue * (1 - weight) + upperValue * weight;
}

/**
 * Returns a length-101 array `out` such that `out[p]` is the `p`-th
 * percentile value of `sortedValues`, for every integer `p` in `[0, 100]`.
 * The caller passes the sorted array so that one sort can amortize across
 * 101 percentile reads.
 */
export function computeAllPercentiles({
  sortedValues,
}: {
  readonly sortedValues: readonly number[];
}): number[] {
  const out: number[] = new Array(101);
  for (let p = 0; p <= 100; p += 1) {
    out[p] = computePercentile({ sortedValues, p });
  }
  return out;
}
