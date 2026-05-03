import type { QuoteTick } from "@wiggler/types/exchanges";

type InterpolateMidsAtTimestampsParams = {
  readonly ticks: readonly QuoteTick[];
  readonly timestampsMs: readonly number[];
};

/**
 * Linearly interpolates one exchange's tick stream onto an external array
 * of timestamps. Output array has the same length as `timestampsMs`, with
 * `null` for any timestamp outside the `[first, last]` tick range and a
 * linearly-interpolated mid in between.
 *
 * Used to align every series onto a single uniform time grid for charts
 * (uPlot in particular) that require all series to share a single x axis.
 *
 * `timestampsMs` is assumed sorted ascending.
 */
export function interpolateMidsAtTimestamps({
  ticks,
  timestampsMs,
}: InterpolateMidsAtTimestampsParams): Array<number | null> {
  const sorted = [...ticks].sort(
    (a, b) => a.tsReceivedMs - b.tsReceivedMs,
  );
  if (sorted.length === 0) {
    return timestampsMs.map(() => null);
  }

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) {
    return timestampsMs.map(() => null);
  }

  const out: Array<number | null> = [];
  let cursor = 0;

  for (const t of timestampsMs) {
    if (t < first.tsReceivedMs || t > last.tsReceivedMs) {
      out.push(null);
      continue;
    }
    while (cursor + 1 < sorted.length) {
      const next = sorted[cursor + 1];
      if (next === undefined || next.tsReceivedMs > t) {break;}
      cursor += 1;
    }
    const left = sorted[cursor];
    const right = sorted[cursor + 1];
    if (left === undefined) {
      out.push(null);
      continue;
    }
    if (right === undefined || left.tsReceivedMs === t) {
      out.push(left.mid);
      continue;
    }
    const span = right.tsReceivedMs - left.tsReceivedMs;
    if (span <= 0) {
      out.push(left.mid);
      continue;
    }
    const alpha = (t - left.tsReceivedMs) / span;
    out.push(left.mid + alpha * (right.mid - left.mid));
  }

  return out;
}
