/**
 * Stable identifiers for each exchange feed alea can subscribe to.
 * `<venue>-<product>` form so spot vs perp/swap stays unambiguous.
 */
export const exchangeIdValues = [
  "coinbase-spot",
  "coinbase-perp",
  "bitstamp-spot",
  "gemini-spot",
  "binance-spot",
  "binance-perp",
  "okx-spot",
  "okx-swap",
  "bybit-spot",
  "bybit-perp",
  "polymarket-chainlink",
] as const;
