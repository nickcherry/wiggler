import type { Asset } from "@alea/types/assets";

/**
 * Maps a alea asset code to the Binance USDT spot pair symbol.
 */
export function binanceSymbol({ asset }: { readonly asset: Asset }): string {
  return `${asset.toUpperCase()}USDT`;
}
