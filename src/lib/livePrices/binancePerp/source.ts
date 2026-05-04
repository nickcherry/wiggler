import {
  fetchExactFiveMinuteBar,
  fetchRecentFiveMinuteBars,
} from "@alea/lib/livePrices/binancePerp/fetchRecentFiveMinuteBars";
import { streamBinancePerpLive } from "@alea/lib/livePrices/binancePerp/streamBinancePerpLive";
import type { LivePriceSource } from "@alea/lib/livePrices/source";

export const binancePerpLivePriceSource: LivePriceSource = {
  id: "binance-perp",
  stream: streamBinancePerpLive,
  fetchRecentFiveMinuteBars,
  fetchExactFiveMinuteBar,
};
