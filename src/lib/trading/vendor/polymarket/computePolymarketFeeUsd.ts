/**
 * Polymarket CLOB fees are assessed in USDC at match time as:
 *
 *   shares * feeRate * price * (1 - price)
 *
 * where feeRate is expressed as a decimal (720 bps -> 0.072). The venue
 * rounds fees to five decimal places and very small fees round to zero.
 */
export function computePolymarketFeeUsd({
  size,
  price,
  feeRateBps,
}: {
  readonly size: number;
  readonly price: number;
  readonly feeRateBps: number;
}): number {
  if (
    !Number.isFinite(size) ||
    !Number.isFinite(price) ||
    !Number.isFinite(feeRateBps) ||
    size <= 0 ||
    price <= 0 ||
    price >= 1 ||
    feeRateBps <= 0
  ) {
    return 0;
  }
  const raw = size * (feeRateBps / 10_000) * price * (1 - price);
  return Math.round(raw * 100_000) / 100_000;
}
