import type { ExchangeId } from "@wiggler/types/exchanges";

/**
 * Static venue weights for the spot consensus VWAP line. Approximations of
 * each venue's share of recent BTC/USD-equivalent spot volume; refresh as
 * market structure changes. Perps and polymarket-chainlink are intentionally
 * absent — perps trade at a funding-driven basis to spot, and chainlink is
 * the oracle we're trying to predict, not an underlying.
 *
 * Weights sum to 1.0 so the consensus can be interpreted as a venue-share-
 * weighted spot price.
 */
export const exchangeSpotVolumeWeights: Partial<Record<ExchangeId, number>> = {
  "binance-spot": 0.6,
  "coinbase-spot": 0.18,
  "bybit-spot": 0.07,
  "okx-spot": 0.07,
  "bitstamp-spot": 0.05,
  "gemini-spot": 0.03,
};
