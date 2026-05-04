import type { TradeDecision } from "@alea/lib/trading/decision/types";
import type { DryRunEvent } from "@alea/lib/trading/dryRun/types";
import type { Asset } from "@alea/types/assets";
import pc from "picocolors";

/**
 * Renders one dry-run event as a single ANSI-coloured line. Color is
 * advisory — picocolors disables itself in non-TTY contexts so piped
 * output stays plain text. The wording carries the meaning either way.
 */
export function formatDryRunEvent({
  event,
}: {
  readonly event: DryRunEvent;
}): string {
  const ts = pc.dim(timestamp({ ms: event.atMs }));
  switch (event.kind) {
    case "info":
      return `${ts} ${event.message}`;
    case "warn":
      return `${ts} ${pc.yellow(event.message)}`;
    case "error":
      return `${ts} ${pc.red(event.message)}`;
    case "decision":
      return `${ts} ${formatDecision({ decision: event.decision })}`;
  }
}

function formatDecision({
  decision,
}: {
  readonly decision: TradeDecision;
}): string {
  if (decision.kind === "trade") {
    const s = decision.snapshot;
    return [
      pc.bold(labelAsset(s.asset)),
      `${formatRem({ remaining: s.remaining })}`,
      `line=${s.line.toFixed(decimalsFor({ asset: s.asset }))}`,
      `px=${s.currentPrice.toFixed(decimalsFor({ asset: s.asset }))}`,
      `${distanceLabel({ snapshot: s })}`,
      `ema=${s.ema50.toFixed(decimalsFor({ asset: s.asset }))}`,
      `${alignmentLabel({ aligned: s.aligned })}`,
      `ourP=${decision.chosen.ourProbability.toFixed(3)}`,
      `mkt(up=${formatBid({ value: decision.chosen.side === "up" ? decision.chosen.bid : decision.other.bid })} down=${formatBid({ value: decision.chosen.side === "down" ? decision.chosen.bid : decision.other.bid })})`,
      pc.green(
        `→ TAKE ${decision.chosen.side.toUpperCase()} @${decision.chosen.bid?.toFixed(2) ?? "?"} edge=${formatSigned({ value: decision.chosen.edge ?? 0 })}`,
      ),
    ].join(" ");
  }
  if (decision.snapshot === null) {
    return `${pc.dim(decision.reason.toUpperCase())} (no snapshot)`;
  }
  const s = decision.snapshot;
  const tail =
    decision.up === null && decision.down === null
      ? ""
      : ` edges(up=${formatEdge({ edge: decision.up?.edge ?? null })} down=${formatEdge({ edge: decision.down?.edge ?? null })})`;
  return [
    pc.bold(labelAsset(s.asset)),
    `${formatRem({ remaining: s.remaining })}`,
    `line=${s.line.toFixed(decimalsFor({ asset: s.asset }))}`,
    `px=${s.currentPrice.toFixed(decimalsFor({ asset: s.asset }))}`,
    `${distanceLabel({ snapshot: s })}`,
    `${alignmentLabel({ aligned: s.aligned })}`,
    pc.yellow(`→ SKIP ${decision.reason}${tail}`),
  ].join(" ");
}

function timestamp({ ms }: { readonly ms: number }): string {
  return new Date(ms).toISOString().slice(11, 19);
}

function labelAsset(asset: Asset): string {
  return asset.toUpperCase().padEnd(5);
}

function formatRem({
  remaining,
}: {
  readonly remaining: 1 | 2 | 3 | 4;
}): string {
  return pc.dim(`[rem=${remaining}m]`);
}

function distanceLabel({
  snapshot,
}: {
  readonly snapshot: {
    readonly distanceBp: number;
    readonly currentSide: "up" | "down";
  };
}): string {
  const arrow = snapshot.currentSide === "up" ? pc.green("↑") : pc.red("↓");
  return `${snapshot.distanceBp}bp${arrow}`;
}

function alignmentLabel({ aligned }: { readonly aligned: boolean }): string {
  return aligned ? pc.cyan("aligned") : pc.dim("vs-regime");
}

function formatBid({ value }: { readonly value: number | null }): string {
  if (value === null) {
    return pc.dim("--");
  }
  return value.toFixed(2);
}

function formatEdge({ edge }: { readonly edge: number | null }): string {
  if (edge === null) {
    return pc.dim("--");
  }
  return formatSigned({ value: edge });
}

function formatSigned({ value }: { readonly value: number }): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(3)}`;
}

function decimalsFor({ asset }: { readonly asset: Asset }): number {
  switch (asset) {
    case "btc":
    case "eth":
      return 2;
    case "sol":
    case "xrp":
      return 4;
    case "doge":
      return 5;
  }
}
