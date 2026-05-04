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
 * Composes the post-window Telegram message. Two flavours:
 *
 *   - All five assets had `kind: "none"` → "No trades entered this
 *     market." plus a `Total Pnl: $0.00` line. The phrasing matches
 *     the chunk-2 spec exactly.
 *   - Otherwise → one line per asset (in the order the caller passed
 *     them in) describing what happened, then a blank line, then
 *     `Total Pnl: $X.XX` summing all net PnLs.
 */
export function formatWindowSummary({
  outcomes,
}: {
  readonly outcomes: readonly AssetWindowOutcome[];
}): string {
  const totalPnl = outcomes.reduce(
    (acc, o) => acc + (o.kind === "traded" ? o.netPnlUsd : 0),
    0,
  );
  const nonEmpty = outcomes.some((o) => o.kind !== "none");
  if (!nonEmpty) {
    return [
      "No trades entered this market.",
      "",
      `Total Pnl: ${formatSignedUsd({ value: totalPnl })}`,
    ].join("\n");
  }
  const lines = outcomes.map((o) => formatOutcomeLine({ outcome: o }));
  lines.push("");
  lines.push(`Total Pnl: ${formatSignedUsd({ value: totalPnl })}`);
  return lines.join("\n");
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
