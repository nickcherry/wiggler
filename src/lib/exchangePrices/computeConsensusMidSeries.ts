import type { ExchangeId, QuoteTick } from "@wiggler/types/exchanges";

type ComputeConsensusMidSeriesParams = {
  readonly ticks: readonly QuoteTick[];
  readonly weights: Partial<Record<ExchangeId, number>>;
  readonly binMs: number;
};

/**
 * Computes a venue-share-weighted consensus mid price as a uniformly-binned
 * `[ts, mid]` series. Each contributing exchange's most recent observed mid
 * is held forward (zero-order hold); at each bin the consensus is
 *
 *   sum(weight_i * mid_i) / sum(weight_i over exchanges with at least one tick)
 *
 * which means the average renormalizes onto whichever venues have already
 * reported, instead of stalling at zero until the slowest venue has emitted
 * its first tick.
 *
 * Bins start at the earliest contributing tick and step `binMs` forward
 * through the latest contributing tick. Bins where no contributing venue has
 * yet reported are skipped.
 */
export function computeConsensusMidSeries({
  ticks,
  weights,
  binMs,
}: ComputeConsensusMidSeriesParams): Array<[number, number]> {
  if (ticks.length === 0 || binMs <= 0) {
    return [];
  }

  const ticksByExchange = new Map<ExchangeId, QuoteTick[]>();
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;

  for (const tick of ticks) {
    const weight = weights[tick.exchange] ?? 0;
    if (weight <= 0) {continue;}
    const list = ticksByExchange.get(tick.exchange) ?? [];
    list.push(tick);
    ticksByExchange.set(tick.exchange, list);
    if (tick.tsReceivedMs < startMs) {startMs = tick.tsReceivedMs;}
    if (tick.tsReceivedMs > endMs) {endMs = tick.tsReceivedMs;}
  }

  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    ticksByExchange.size === 0
  ) {
    return [];
  }

  for (const list of ticksByExchange.values()) {
    list.sort((a, b) => a.tsReceivedMs - b.tsReceivedMs);
  }

  const cursors = new Map<ExchangeId, number>();
  const lastMid = new Map<ExchangeId, number>();
  const out: Array<[number, number]> = [];

  for (let t = startMs; t <= endMs; t += binMs) {
    for (const [exchange, list] of ticksByExchange) {
      let cursor = cursors.get(exchange) ?? 0;
      while (cursor < list.length) {
        const next = list[cursor];
        if (next === undefined || next.tsReceivedMs > t) {break;}
        lastMid.set(exchange, next.mid);
        cursor += 1;
      }
      cursors.set(exchange, cursor);
    }

    let weightedSum = 0;
    let weightSum = 0;
    for (const [exchange, mid] of lastMid) {
      const weight = weights[exchange] ?? 0;
      weightedSum += weight * mid;
      weightSum += weight;
    }
    if (weightSum > 0) {
      out.push([t, weightedSum / weightSum]);
    }
  }

  return out;
}
