import {
  baselineReliabilitySource,
  comparableReliabilitySourceValues,
  type DirectionalOutcome,
  type ReliabilityAssetWindow,
  type ReliabilitySourceCell,
} from "@alea/lib/reliability/types";
import { labelAsset } from "@alea/lib/trading/live/utils";
import pc from "picocolors";

export function formatReliabilityWindow({
  windowStartMs,
  windows,
}: {
  readonly windowStartMs: number;
  readonly windows: readonly ReliabilityAssetWindow[];
}): string {
  const windowEndMs = windowStartMs + 5 * 60 * 1000;
  const lines: string[] = [
    "",
    `${pc.bold("Directional agreement")} ${pc.dim(`${formatClock({ ms: windowStartMs })}-${formatClock({ ms: windowEndMs })} UTC`)}`,
    [
      pc.dim("asset".padEnd(7)),
      pc.dim("poly".padEnd(20)),
      pc.dim("cb spot".padEnd(24)),
      pc.dim("cb perp".padEnd(24)),
      pc.dim("bn spot".padEnd(24)),
      pc.dim("bn perp".padEnd(24)),
    ].join(""),
  ];

  for (const window of [...windows].sort((a, b) =>
    a.asset.localeCompare(b.asset),
  )) {
    const baseline = window.sources[baselineReliabilitySource];
    lines.push(
      [
        pc.bold(labelAsset(window.asset).padEnd(7)),
        formatBaseline({ cell: baseline }).padEnd(20),
        ...comparableReliabilitySourceValues.map((source) =>
          formatComparable({ cell: window.sources[source] }).padEnd(24),
        ),
      ].join(""),
    );
  }
  return lines.join("\n");
}

function formatBaseline({
  cell,
}: {
  readonly cell: ReliabilitySourceCell;
}): string {
  if (cell.status !== "complete") {
    return pc.yellow(shortStatus({ cell }));
  }
  return `${formatOutcome({ outcome: cell.outcome })} ${formatDelta({ cell })} ${formatLag({ cell })}`;
}

function formatComparable({
  cell,
}: {
  readonly cell: ReliabilitySourceCell;
}): string {
  if (cell.agreesWithPolymarket === true) {
    return pc.green(
      `OK ${formatOutcome({ outcome: cell.outcome })} ${formatDelta({ cell })} ${formatLag({ cell })}`,
    );
  }
  if (cell.agreesWithPolymarket === false) {
    return pc.red(
      `DIFF ${formatOutcome({ outcome: cell.outcome })} ${formatDelta({ cell })} ${formatLag({ cell })}`,
    );
  }
  return pc.yellow(`${shortStatus({ cell })} ${formatDelta({ cell })}`.trim());
}

function formatOutcome({
  outcome,
}: {
  readonly outcome: DirectionalOutcome | null;
}): string {
  if (outcome === null) {
    return "--";
  }
  return outcome === "up" ? "UP" : "DOWN";
}

function formatDelta({
  cell,
}: {
  readonly cell: ReliabilitySourceCell;
}): string {
  if (cell.deltaBp === null) {
    return "";
  }
  const sign = cell.deltaBp >= 0 ? "+" : "";
  return `${sign}${cell.deltaBp.toFixed(2)}bp`;
}

function formatLag({ cell }: { readonly cell: ReliabilitySourceCell }): string {
  if (cell.startLagMs === null || cell.endLagMs === null) {
    return "";
  }
  return pc.dim(`s${cell.startLagMs} e${cell.endLagMs}`);
}

function shortStatus({
  cell,
}: {
  readonly cell: ReliabilitySourceCell;
}): string {
  switch (cell.status) {
    case "pending":
      return "PENDING";
    case "complete":
      return "OK";
    case "missing-start":
      return "MISS start";
    case "missing-end":
      return "MISS end";
    case "stale-start":
      return "STALE start";
    case "stale-end":
      return "STALE end";
    case "no-market":
      return "NO MARKET";
  }
}

function formatClock({ ms }: { readonly ms: number }): string {
  return new Date(ms).toISOString().slice(11, 16);
}
