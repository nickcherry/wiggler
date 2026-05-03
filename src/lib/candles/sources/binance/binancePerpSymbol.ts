import type { Asset } from "@wiggler/types/assets";

/**
 * Maps a wiggler asset code to the Binance USDT-margined perpetual swap
 * symbol used on the Binance Futures (UM) market.
 */
export function binancePerpSymbol({
  asset,
}: {
  readonly asset: Asset;
}): string {
  return `${asset.toUpperCase()}USDT`;
}
