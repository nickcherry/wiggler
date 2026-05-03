import type { Asset } from "@wiggler/types/assets";

/**
 * Maps a wiggler asset code to the Coinbase International product id used for
 * the asset's perpetual swap, exposed through the Advanced Trade public
 * market data endpoints under the `-PERP-INTX` suffix.
 */
export function coinbasePerpProductId({
  asset,
}: {
  readonly asset: Asset;
}): string {
  return `${asset.toUpperCase()}-PERP-INTX`;
}
