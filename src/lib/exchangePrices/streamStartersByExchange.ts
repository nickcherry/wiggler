import { streamBinancePerpQuotes } from "@alea/lib/exchangePrices/sources/binance/streamBinancePerpQuotes";
import { streamBinanceSpotQuotes } from "@alea/lib/exchangePrices/sources/binance/streamBinanceSpotQuotes";
import { streamBitstampSpotQuotes } from "@alea/lib/exchangePrices/sources/bitstamp/streamBitstampSpotQuotes";
import { streamBybitPerpQuotes } from "@alea/lib/exchangePrices/sources/bybit/streamBybitPerpQuotes";
import { streamBybitSpotQuotes } from "@alea/lib/exchangePrices/sources/bybit/streamBybitSpotQuotes";
import { streamCoinbasePerpQuotes } from "@alea/lib/exchangePrices/sources/coinbase/streamCoinbasePerpQuotes";
import { streamCoinbaseSpotQuotes } from "@alea/lib/exchangePrices/sources/coinbase/streamCoinbaseSpotQuotes";
import { streamGeminiSpotQuotes } from "@alea/lib/exchangePrices/sources/gemini/streamGeminiSpotQuotes";
import { streamOkxSpotQuotes } from "@alea/lib/exchangePrices/sources/okx/streamOkxSpotQuotes";
import { streamOkxSwapQuotes } from "@alea/lib/exchangePrices/sources/okx/streamOkxSwapQuotes";
import { streamPolymarketChainlinkQuotes } from "@alea/lib/exchangePrices/sources/polymarket/streamPolymarketChainlinkQuotes";
import type {
  StreamHandle,
  StreamQuotesParams,
} from "@alea/lib/exchangePrices/types";
import type { ExchangeId } from "@alea/types/exchanges";

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
  "coinbase-perp": streamCoinbasePerpQuotes,
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
