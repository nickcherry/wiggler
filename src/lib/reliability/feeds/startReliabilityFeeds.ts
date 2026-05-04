import {
  streamBinancePerpReliabilityPrices,
  streamBinanceSpotReliabilityPrices,
} from "@alea/lib/reliability/feeds/binance";
import {
  streamCoinbasePerpReliabilityPrices,
  streamCoinbaseSpotReliabilityPrices,
} from "@alea/lib/reliability/feeds/coinbase";
import { streamPolymarketChainlinkReliabilityPrices } from "@alea/lib/reliability/feeds/polymarket";
import type {
  ReliabilityFeedCallbacks,
  ReliabilityFeedHandle,
} from "@alea/lib/reliability/feeds/types";

export function startReliabilityFeeds(
  callbacks: ReliabilityFeedCallbacks,
): ReliabilityFeedHandle {
  const handles = [
    streamPolymarketChainlinkReliabilityPrices(callbacks),
    streamCoinbaseSpotReliabilityPrices(callbacks),
    streamCoinbasePerpReliabilityPrices(callbacks),
    streamBinanceSpotReliabilityPrices(callbacks),
    streamBinancePerpReliabilityPrices(callbacks),
  ];

  return {
    stop: async () => {
      await Promise.allSettled(handles.map((handle) => handle.stop()));
    },
  };
}
