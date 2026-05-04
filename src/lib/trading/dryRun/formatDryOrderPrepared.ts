import type { LeadingSide } from "@alea/lib/trading/types";
import type { Asset } from "@alea/types/assets";

/**
 * Telegram body for a dry-run virtual order. The wording is deliberately
 * explicit that no venue order was posted, while preserving the same
 * operator-facing shape as live placement alerts.
 */
export function formatDryOrderPrepared({
  asset,
  side,
  stakeUsd,
  underlyingPrice,
  linePrice,
  limitPrice,
  sharesIfFilled,
  modelProbability,
  edge,
  queueAheadShares,
  windowEndMs,
  nowMs,
}: {
  readonly asset: Asset;
  readonly side: LeadingSide;
  readonly stakeUsd: number;
  readonly underlyingPrice: number;
  readonly linePrice: number;
  readonly limitPrice: number;
  readonly sharesIfFilled: number;
  readonly modelProbability: number;
  readonly edge: number | null;
  readonly queueAheadShares: number | null;
  readonly windowEndMs: number;
  readonly nowMs: number;
}): string {
  const arrow = side === "up" ? "↑" : "↓";
  const headline = `DRY RUN: prepared virtual order for $${formatStake({ stakeUsd })} of ${asset.toUpperCase()} ${arrow} at ${formatLimitPrice({ value: limitPrice })}`;
  const linePctLabel = formatLineRelativePercent({
    linePrice,
    underlyingPrice,
  });
  const lineLabel = `Price line is ${formatUnderlyingPrice({ asset, value: linePrice })}${linePctLabel === null ? "" : ` (${linePctLabel})`}`;
  const expiresLabel = `Market expires in ${formatDuration({ ms: Math.max(0, windowEndMs - nowMs) })}.`;
  return [
    headline,
    "",
    `Underlying is ${formatUnderlyingPrice({ asset, value: underlyingPrice })}. ${lineLabel}.`,
    `Model p=${modelProbability.toFixed(3)}, edge=${edge === null ? "--" : formatSigned({ value: edge })}; shares=${formatShares({ value: sharesIfFilled })}; queue ahead=${queueAheadShares === null ? "unknown" : formatShares({ value: queueAheadShares })}.`,
    expiresLabel,
  ].join("\n");
}

function formatLineRelativePercent({
  linePrice,
  underlyingPrice,
}: {
  readonly linePrice: number;
  readonly underlyingPrice: number;
}): string | null {
  if (
    !Number.isFinite(linePrice) ||
    !Number.isFinite(underlyingPrice) ||
    underlyingPrice === 0
  ) {
    return null;
  }
  const pct = ((linePrice - underlyingPrice) / underlyingPrice) * 100;
  return formatSignedPercent({ value: pct });
}

function formatSignedPercent({ value }: { readonly value: number }): string {
  const sign = value >= 0 ? "+" : "-";
  const abs = Math.abs(value);
  const rounded = Math.round(abs * 1000) / 1000;
  let str = rounded.toFixed(3);
  while (str.endsWith("0") && !str.endsWith(".0")) {
    str = str.slice(0, -1);
  }
  return `${sign}${str}%`;
}

function formatStake({ stakeUsd }: { readonly stakeUsd: number }): string {
  if (Number.isInteger(stakeUsd)) {
    return String(stakeUsd);
  }
  return stakeUsd.toFixed(2);
}

function formatUnderlyingPrice({
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

function formatLimitPrice({ value }: { readonly value: number }): string {
  let str = value.toFixed(3);
  while (str.endsWith("0") && decimalPlaces({ value: str }) > 2) {
    str = str.slice(0, -1);
  }
  return `$${str}`;
}

function decimalPlaces({ value }: { readonly value: string }): number {
  return value.split(".")[1]?.length ?? 0;
}

function formatShares({ value }: { readonly value: number }): string {
  return value.toFixed(2);
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
