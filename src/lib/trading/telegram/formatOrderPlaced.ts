import type { LeadingSide } from "@alea/lib/trading/types";
import type { Asset } from "@alea/types/assets";

/**
 * Composes the human-readable Telegram body the bot ships every time
 * it places a limit order. Reads like a note from a person, not a log
 * line — that was the explicit design constraint from the chunk-2
 * spec. Layout (one blank line between the headline and the rest):
 *
 *   Placed order for $20 of BTC ↑ @ $80,251.35
 *
 *   Price line is $80,253.10
 *   Market expires in 2 minutes 20 seconds.
 */
export function formatOrderPlaced({
  asset,
  side,
  stakeUsd,
  underlyingPrice,
  linePrice,
  windowEndMs,
  nowMs,
}: {
  readonly asset: Asset;
  readonly side: LeadingSide;
  readonly stakeUsd: number;
  /** Latest underlying spot/perp price at the moment we placed the order. */
  readonly underlyingPrice: number;
  /** The window's line (open price). */
  readonly linePrice: number;
  readonly windowEndMs: number;
  readonly nowMs: number;
}): string {
  const arrow = side === "up" ? "↑" : "↓";
  const headline = `Placed order for $${formatStake({ stakeUsd })} of ${asset.toUpperCase()} ${arrow} @ ${formatPrice({ asset, value: underlyingPrice })}`;
  const lineLabel = `Price line is ${formatPrice({ asset, value: linePrice })}`;
  const expiresLabel = `Market expires in ${formatDuration({ ms: Math.max(0, windowEndMs - nowMs) })}.`;
  return `${headline}\n\n${lineLabel}\n${expiresLabel}`;
}

function formatStake({ stakeUsd }: { readonly stakeUsd: number }): string {
  // Fixed-stake bot ships whole-dollar values today (STAKE_USD = 20),
  // but format as `20` rather than `20.00` for the human-readable
  // headline. Drop trailing `.0` only.
  if (Number.isInteger(stakeUsd)) {
    return String(stakeUsd);
  }
  return stakeUsd.toFixed(2);
}

/**
 * Formats an underlying price the way a person would: thousands
 * separators, asset-appropriate decimals.
 */
function formatPrice({
  asset,
  value,
}: {
  readonly asset: Asset;
  readonly value: number;
}): string {
  const decimals = decimalsFor({ asset });
  const fixed = value.toFixed(decimals);
  const [whole, fraction] = fixed.split(".");
  const wholeWithCommas = (whole ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (fraction === undefined) {
    return `$${wholeWithCommas}`;
  }
  return `$${wholeWithCommas}.${fraction}`;
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

function formatDuration({ ms }: { readonly ms: number }): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) {
    return totalSeconds === 1 ? "1 second" : `${totalSeconds} seconds`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const minutesPart = minutes === 1 ? "1 minute" : `${minutes} minutes`;
  if (seconds === 0) {
    return minutesPart;
  }
  const secondsPart = seconds === 1 ? "1 second" : `${seconds} seconds`;
  return `${minutesPart} ${secondsPart}`;
}
