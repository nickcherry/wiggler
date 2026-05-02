/**
 * Stable identifiers for each exchange feed wiggler can subscribe to.
 * `<venue>-<product>` form so spot vs perp/swap stays unambiguous.
 */
export const exchangeIdValues = [
  "coinbase-spot",
  "kraken-spot",
  "bitstamp-spot",
  "gemini-spot",
  "binance-spot",
  "binance-perp",
  "okx-spot",
  "okx-swap",
  "bybit-spot",
  "bybit-perp",
  "bitfinex-spot",
] as const;
