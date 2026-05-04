import { resolveDirectionalOutcome } from "@alea/lib/reliability/resolveDirectionalOutcome";
import {
  baselineReliabilitySource,
  type ReliabilityAssetWindow,
  type ReliabilityCellStatus,
  type ReliabilitySourceCell,
  reliabilitySourceValues,
} from "@alea/lib/reliability/types";

export function finalizeReliabilityWindow({
  window,
  finalizedAtMs,
  graceMs,
}: {
  readonly window: ReliabilityAssetWindow;
  readonly finalizedAtMs: number;
  readonly graceMs: number;
}): ReliabilityAssetWindow {
  const finalized: ReliabilityAssetWindow = {
    ...window,
    status: "complete",
    finalizedAtMs,
    sources: { ...window.sources },
  };

  for (const source of reliabilitySourceValues) {
    const cell = finalizeCell({
      cell: finalized.sources[source],
      marketStatus: finalized.marketStatus,
      graceMs,
    });
    finalized.sources[source] = cell;
  }

  const baseline = finalized.sources[baselineReliabilitySource];
  for (const source of reliabilitySourceValues) {
    const cell = finalized.sources[source];
    finalized.sources[source] = {
      ...cell,
      agreesWithPolymarket:
        source === baselineReliabilitySource ||
        baseline.status !== "complete" ||
        cell.status !== "complete" ||
        baseline.outcome === null ||
        cell.outcome === null
          ? null
          : cell.outcome === baseline.outcome,
    };
  }

  return finalized;
}

function finalizeCell({
  cell,
  marketStatus,
  graceMs,
}: {
  readonly cell: ReliabilitySourceCell;
  readonly marketStatus: ReliabilityAssetWindow["marketStatus"];
  readonly graceMs: number;
}): ReliabilitySourceCell {
  if (marketStatus !== "active") {
    return {
      ...cell,
      status: "no-market",
      deltaBp: null,
      outcome: null,
      agreesWithPolymarket: null,
    };
  }

  const status = resolveStatus({ cell, graceMs });
  if (cell.startPrice === null || cell.endPrice === null) {
    return {
      ...cell,
      status,
      deltaBp: null,
      outcome: null,
      agreesWithPolymarket: null,
    };
  }

  const deltaBp =
    ((cell.endPrice - cell.startPrice) / cell.startPrice) * 10_000;
  return {
    ...cell,
    status,
    deltaBp,
    outcome: resolveDirectionalOutcome({
      startPrice: cell.startPrice,
      endPrice: cell.endPrice,
    }),
    agreesWithPolymarket: null,
  };
}

function resolveStatus({
  cell,
  graceMs,
}: {
  readonly cell: ReliabilitySourceCell;
  readonly graceMs: number;
}): ReliabilityCellStatus {
  if (cell.startPrice === null) {
    return "missing-start";
  }
  if (cell.endPrice === null) {
    return "missing-end";
  }
  if (cell.startLagMs !== null && cell.startLagMs > graceMs) {
    return "stale-start";
  }
  if (cell.endLagMs !== null && cell.endLagMs > graceMs) {
    return "stale-end";
  }
  return "complete";
}
