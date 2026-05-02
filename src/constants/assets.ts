/**
 * Active asset whitelist. The bot trades these and the runtime fetches
 * candles for each. Lower-case canonical form; uppercase for display
 * and DB rows.
 */
export const assetValues = ["btc", "eth", "sol", "xrp", "doge"] as const;
