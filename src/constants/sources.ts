/**
 * Candle data sources currently supported. Stored on persisted candle rows
 * so the same asset/timeframe can be tracked from multiple exchanges.
 */
export const candleSourceValues = ["coinbase", "binance"] as const;
