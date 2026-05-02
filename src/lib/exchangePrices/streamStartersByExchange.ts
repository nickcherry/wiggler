import { streamBinancePerpQuotes } from "@wiggler/lib/exchangePrices/sources/binance/streamBinancePerpQuotes";
import { streamBinanceSpotQuotes } from "@wiggler/lib/exchangePrices/sources/binance/streamBinanceSpotQuotes";
import { streamBitstampSpotQuotes } from "@wiggler/lib/exchangePrices/sources/bitstamp/streamBitstampSpotQuotes";
import { streamBybitPerpQuotes } from "@wiggler/lib/exchangePrices/sources/bybit/streamBybitPerpQuotes";
import { streamBybitSpotQuotes } from "@wiggler/lib/exchangePrices/sources/bybit/streamBybitSpotQuotes";
import { streamCoinbaseSpotQuotes } from "@wiggler/lib/exchangePrices/sources/coinbase/streamCoinbaseSpotQuotes";
import { streamGeminiSpotQuotes } from "@wiggler/lib/exchangePrices/sources/gemini/streamGeminiSpotQuotes";
import { streamOkxSpotQuotes } from "@wiggler/lib/exchangePrices/sources/okx/streamOkxSpotQuotes";
import { streamOkxSwapQuotes } from "@wiggler/lib/exchangePrices/sources/okx/streamOkxSwapQuotes";
import { streamPolymarketChainlinkQuotes } from "@wiggler/lib/exchangePrices/sources/polymarket/streamPolymarketChainlinkQuotes";
import type {
  StreamHandle,
  StreamQuotesParams,
} from "@wiggler/lib/exchangePrices/types";
import type { ExchangeId } from "@wiggler/types/exchanges";

/**
 * Function signature shared by every per-exchange stream-starter.
 */
export type StartQuoteStream = (params: StreamQuotesParams) => StreamHandle;

/**
 * Lookup of every supported exchange's stream-starter. New exchange
 * implementations should register themselves here.
 */
export const streamStartersByExchange: Record<ExchangeId, StartQuoteStream> = {
  "coinbase-spot": streamCoinbaseSpotQuotes,
  "bitstamp-spot": streamBitstampSpotQuotes,
  "gemini-spot": streamGeminiSpotQuotes,
  "binance-spot": streamBinanceSpotQuotes,
  "binance-perp": streamBinancePerpQuotes,
  "okx-spot": streamOkxSpotQuotes,
  "okx-swap": streamOkxSwapQuotes,
  "bybit-spot": streamBybitSpotQuotes,
  "bybit-perp": streamBybitPerpQuotes,
  "polymarket-chainlink": streamPolymarketChainlinkQuotes,
};
