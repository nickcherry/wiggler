import type { ExchangeId } from "@wiggler/types/exchanges";

/**
 * Static venue weights for the perp consensus VWAP line. Approximations of
 * each venue's share of recent BTC USDT perpetual / swap volume; refresh as
 * market structure changes. Spot venues and polymarket-chainlink are
 * absent — they belong to the spot consensus or are the prediction target.
 *
 * Weights sum to 1.0 so the consensus can be interpreted as a venue-share-
 * weighted perpetual price.
 */
export const exchangePerpVolumeWeights: Partial<Record<ExchangeId, number>> = {
  "binance-perp": 0.65,
  "bybit-perp": 0.2,
  "okx-swap": 0.15,
};
