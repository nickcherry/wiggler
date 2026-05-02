/**
 * Stable candle timeframes the system understands.
 * Stored as the `timeframe` column on persisted candle rows.
 */
export const candleTimeframeValues = ["1m", "5m"] as const;

/**
 * Number of candles requested per page when paginating through an
 * exchange historical API. 288 five-minute candles == 1 calendar day,
 * which fits inside both Coinbase Advanced Trade and Binance per-request limits.
 */
export const candlesPerFetchPage = 288;

/**
 * Default lookback window when none is specified.
 */
export const defaultCandleLookbackDays = 730;
