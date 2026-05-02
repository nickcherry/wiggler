import type { Asset } from "@wiggler/types/assets";

/**
 * Maps a wiggler asset code to the Binance USDT spot pair symbol.
 */
export function binanceSymbol({ asset }: { readonly asset: Asset }): string {
  return `${asset.toUpperCase()}USDT`;
}
