import type { LeadingSide } from "@alea/lib/trading/types";
import type { Asset } from "@alea/types/assets";

/**
 * Telegram body for an order placement that failed twice in a row
 * with a non-postOnly error. PostOnly rejections (the price moved away
 * between book read and post) are silent and counted in the per-window
 * summary instead — those are an expected friction of being a maker,
 * not an alert.
 */
export function formatOrderError({
  asset,
  side,
  errorMessage,
  retried = true,
}: {
  readonly asset: Asset;
  readonly side: LeadingSide;
  readonly errorMessage: string;
  readonly retried?: boolean;
}): string {
  const arrow = side === "up" ? "↑" : "↓";
  return [
    `Error placing ${asset.toUpperCase()} ${arrow} order: ${errorMessage}`,
    "",
    retried
      ? "(Retried once. Bot continues.)"
      : "(Reconciled venue state before giving up. Bot continues.)",
  ].join("\n");
}
