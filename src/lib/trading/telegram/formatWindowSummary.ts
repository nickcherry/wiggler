import type { LeadingSide } from "@alea/lib/trading/types";
import type { Asset } from "@alea/types/assets";

/**
 * Per-asset outcome of one trading window. The runner builds one of
 * these for each asset it watched, then hands them to
 * `formatWindowSummary` to compose the message body.
 *
 *   - `none`       → no order was ever placed for this asset.
 *   - `unfilled`   → we placed an order, it never filled, and we
 *                   cancelled it before window close.
 *   - `traded`     → we filled (in part or in full) and held to
 *                   settlement; carries net PnL with maker fees.
 */
export type AssetWindowOutcome =
  | { readonly asset: Asset; readonly kind: "none" }
  | {
      readonly asset: Asset;
      readonly kind: "unfilled";
      readonly side: LeadingSide;
      readonly limitPrice: number;
    }
  | {
      readonly asset: Asset;
      readonly kind: "traded";
      readonly side: LeadingSide;
      readonly fillPrice: number;
      readonly sharesFilled: number;
      readonly costUsd: number;
      readonly feesUsd: number;
      readonly netPnlUsd: number;
      readonly won: boolean;
    };

/**
 * Optional cross-the-book / retry instrumentation surfaced at the bottom
 * of the summary. Only rendered when at least one count is non-zero
 * — a clean window stays clean.
 *
 *   - `rejectedCount` counts postOnly rejections we observed during the
 *     window (the price moved between book read and post).
 *   - `placedAfterRetryCount` counts orders that *eventually placed
 *     successfully* after one or more cross-book rejections. So
 *     `rejectedCount − placedAfterRetryCount` is roughly "rejections
 *     that ended in giving up because the edge disappeared."
 */
export type WindowPlacementStats = {
  readonly rejectedCount: number;
  readonly placedAfterRetryCount: number;
};

/**
 * Composes the post-window Telegram message. Two flavours:
 *
 *   - All five assets had `kind: "none"` → "No trades entered this
 *     market." plus a `Total Pnl: $0.00` line. The phrasing matches
 *     the chunk-2 spec exactly.
 *   - Otherwise → one line per asset (in the order the caller passed
 *     them in) describing what happened, then a blank line, then
 *     `Total Pnl: $X.XX` summing all net PnLs.
 *
 * When `stats` is supplied and any of its counts are non-zero, an
 * extra trailing line is appended after the Total Pnl.
 */
export function formatWindowSummary({
  outcomes,
  stats,
}: {
  readonly outcomes: readonly AssetWindowOutcome[];
  readonly stats?: WindowPlacementStats;
}): string {
  const totalPnl = outcomes.reduce(
    (acc, o) => acc + (o.kind === "traded" ? o.netPnlUsd : 0),
    0,
  );
  const nonEmpty = outcomes.some((o) => o.kind !== "none");
  const lines: string[] = [];
  if (!nonEmpty) {
    lines.push("No trades entered this market.");
  } else {
    for (const o of outcomes) {
      lines.push(formatOutcomeLine({ outcome: o }));
    }
  }
  lines.push("");
  lines.push(`Total Pnl: ${formatSignedUsd({ value: totalPnl })}`);
  const statsLine = formatStatsLine({ stats });
  if (statsLine !== null) {
    lines.push(statsLine);
  }
  return lines.join("\n");
}

function formatStatsLine({
  stats,
}: {
  readonly stats: WindowPlacementStats | undefined;
}): string | null {
  if (stats === undefined) {
    return null;
  }
  if (stats.rejectedCount === 0 && stats.placedAfterRetryCount === 0) {
    return null;
  }
  if (stats.placedAfterRetryCount === 0) {
    return `Cross-book rejections: ${stats.rejectedCount}`;
  }
  return `Cross-book rejections: ${stats.rejectedCount} (${stats.placedAfterRetryCount} placed after retry)`;
}

function formatOutcomeLine({
  outcome,
}: {
  readonly outcome: AssetWindowOutcome;
}): string {
  const tag = `${outcome.asset.toUpperCase()}:`;
  switch (outcome.kind) {
    case "none":
      return `${tag} no trade`;
    case "unfilled":
      return `${tag} ${arrowOf({ side: outcome.side })} @ $${outcome.limitPrice.toFixed(2)} → didn't fill`;
    case "traded": {
      const verb = outcome.won ? "won" : "lost";
      return `${tag} ${arrowOf({ side: outcome.side })} @ $${outcome.fillPrice.toFixed(2)} → ${verb} ${formatSignedUsd({ value: outcome.netPnlUsd })}`;
    }
  }
}

function arrowOf({ side }: { readonly side: LeadingSide }): string {
  return side === "up" ? "↑" : "↓";
}

function formatSignedUsd({ value }: { readonly value: number }): string {
  if (value === 0) {
    return "$0.00";
  }
  const sign = value > 0 ? "+" : "-";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}
