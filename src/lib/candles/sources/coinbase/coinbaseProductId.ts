import type { Asset } from "@alea/types/assets";

/**
 * Maps a alea asset code to the Coinbase Advanced Trade product id used
 * for spot USD market data.
 */
export function coinbaseProductId({
  asset,
}: {
  readonly asset: Asset;
}): string {
  return `${asset.toUpperCase()}-USD`;
}
