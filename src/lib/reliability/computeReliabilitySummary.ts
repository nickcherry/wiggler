import {
  baselineReliabilitySource,
  comparableReliabilitySourceValues,
  type ReliabilityAssetWindow,
  type ReliabilitySource,
  type ReliabilitySourceSummary,
  type ReliabilitySummary,
} from "@alea/lib/reliability/types";
import type { Asset } from "@alea/types/assets";

export function computeReliabilitySummary({
  completedWindows,
  nearZeroThresholdBp,
}: {
  readonly completedWindows: readonly ReliabilityAssetWindow[];
  readonly nearZeroThresholdBp: number;
}): ReliabilitySummary {
  const sources = comparableReliabilitySourceValues.map((source) =>
    summarizeSource({
      source,
      completedWindows,
      nearZeroThresholdBp,
    }),
  );

  const assets = [...new Set(completedWindows.map((window) => window.asset))];
  const byAsset = assets.flatMap((asset) =>
    comparableReliabilitySourceValues.map((source) => ({
      asset,
      ...summarizeSource({
        source,
        completedWindows: completedWindows.filter(
          (window) => window.asset === asset,
        ),
        nearZeroThresholdBp,
      }),
    })),
  );

  return {
    completedAssetWindows: completedWindows.length,
    baselineCompleteWindows: completedWindows.filter(
      (window) =>
        window.sources[baselineReliabilitySource].status === "complete",
    ).length,
    nearZeroThresholdBp,
    sources,
    byAsset,
  };
}

function summarizeSource({
  source,
  completedWindows,
  nearZeroThresholdBp,
}: {
  readonly source: ReliabilitySource;
  readonly completedWindows: readonly ReliabilityAssetWindow[];
  readonly nearZeroThresholdBp: number;
}): ReliabilitySourceSummary {
  let comparableWindows = 0;
  let agreements = 0;
  let disagreements = 0;
  let nearZeroComparable = 0;
  let nearZeroDisagreements = 0;

  for (const window of completedWindows) {
    const baseline = window.sources[baselineReliabilitySource];
    const cell = window.sources[source];
    if (baseline.status !== "complete" || cell.status !== "complete") {
      continue;
    }
    comparableWindows += 1;
    const nearZero =
      baseline.deltaBp !== null &&
      Math.abs(baseline.deltaBp) <= nearZeroThresholdBp;
    if (nearZero) {
      nearZeroComparable += 1;
    }
    if (cell.agreesWithPolymarket) {
      agreements += 1;
    } else {
      disagreements += 1;
      if (nearZero) {
        nearZeroDisagreements += 1;
      }
    }
  }

  return {
    source,
    totalAssetWindows: completedWindows.length,
    comparableWindows,
    agreements,
    disagreements,
    unavailable: completedWindows.length - comparableWindows,
    agreementRate:
      comparableWindows === 0 ? null : agreements / comparableWindows,
    nearZeroComparable,
    nearZeroDisagreements,
  };
}

export function emptyReliabilitySummary({
  nearZeroThresholdBp,
}: {
  readonly nearZeroThresholdBp: number;
}): ReliabilitySummary {
  return {
    completedAssetWindows: 0,
    baselineCompleteWindows: 0,
    nearZeroThresholdBp,
    sources: comparableReliabilitySourceValues.map((source) => ({
      source,
      totalAssetWindows: 0,
      comparableWindows: 0,
      agreements: 0,
      disagreements: 0,
      unavailable: 0,
      agreementRate: null,
      nearZeroComparable: 0,
      nearZeroDisagreements: 0,
    })),
    byAsset: [],
  };
}

export function assetsInCompletedWindows({
  completedWindows,
}: {
  readonly completedWindows: readonly ReliabilityAssetWindow[];
}): readonly Asset[] {
  return [...new Set(completedWindows.map((window) => window.asset))];
}
