import type { QuoteTick } from "@wiggler/types/exchanges";

type DensifyMidsLinearlyParams = {
  readonly ticks: readonly QuoteTick[];
  readonly binMs: number;
};

/**
 * Linearly interpolates a sparse series of ticks onto a uniform time grid.
 * The visual line shape is preserved exactly — when ECharts connects the
 * dense points with straight segments, the result is indistinguishable
 * from connecting the original sparse points. The point of densification
 * is purely so that an axis-trigger tooltip finds a data point near every
 * cursor x, rather than skipping over the gaps between sparse ticks.
 *
 * Returns the original tick coordinates if there are fewer than two
 * usable ticks (nothing to interpolate between).
 */
export function densifyMidsLinearly({
  ticks,
  binMs,
}: DensifyMidsLinearlyParams): Array<[number, number]> {
  if (binMs <= 0) {
    throw new Error("binMs must be positive");
  }
  const sorted = [...ticks].sort(
    (a, b) => a.tsReceivedMs - b.tsReceivedMs,
  );
  if (sorted.length < 2) {
    return sorted.map((tick) => [tick.tsReceivedMs, tick.mid]);
  }

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) {
    return [];
  }
  const startMs = first.tsReceivedMs;
  const endMs = last.tsReceivedMs;

  const out: Array<[number, number]> = [];
  let rightIndex = 1;

  for (let t = startMs; t <= endMs; t += binMs) {
    while (rightIndex < sorted.length) {
      const right = sorted[rightIndex];
      if (right === undefined || right.tsReceivedMs >= t) break;
      rightIndex += 1;
    }
    const right = sorted[rightIndex];
    const left = sorted[rightIndex - 1];
    if (right === undefined || left === undefined) {
      out.push([last.tsReceivedMs, last.mid]);
      continue;
    }
    if (right.tsReceivedMs === t) {
      out.push([t, right.mid]);
      continue;
    }
    const span = right.tsReceivedMs - left.tsReceivedMs;
    if (span <= 0) {
      out.push([t, left.mid]);
      continue;
    }
    const alpha = (t - left.tsReceivedMs) / span;
    out.push([t, left.mid + alpha * (right.mid - left.mid)]);
  }

  // Make sure the very last actual tick lands in the output exactly so
  // the line ends where the data ends.
  const lastOut = out[out.length - 1];
  if (lastOut === undefined || lastOut[0] < endMs) {
    out.push([endMs, last.mid]);
  }

  return out;
}
