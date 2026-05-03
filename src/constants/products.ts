/**
 * Product variants persisted on each candle row. Spot tracks the cash market;
 * perp tracks the perpetual swap on the same asset (which trades at a small
 * funding-rate basis to spot).
 */
export const productValues = ["spot", "perp"] as const;
