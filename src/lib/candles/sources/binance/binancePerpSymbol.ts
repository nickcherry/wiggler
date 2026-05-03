import type { Asset } from "@alea/types/assets";

/**
 * Maps a alea asset code to the Binance USDT-margined perpetual swap
 * symbol used on the Binance Futures (UM) market.
 */
export function binancePerpSymbol({
  asset,
}: {
  readonly asset: Asset;
}): string {
  return `${asset.toUpperCase()}USDT`;
}
