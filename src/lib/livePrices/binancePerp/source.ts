import { streamBinancePerpQuotes } from "@alea/lib/exchangePrices/sources/binance/streamBinancePerpQuotes";
import {
  fetchExactFiveMinuteBar,
  fetchRecentFiveMinuteBars,
} from "@alea/lib/livePrices/binancePerp/fetchRecentFiveMinuteBars";
import type { LivePriceSource } from "@alea/lib/livePrices/source";
import type {
  LivePriceFeedHandle,
  LivePriceFeedParams,
} from "@alea/lib/livePrices/types";

/**
 * Trader-side adapter around the unified Binance perp quote stream.
 *
 * The unified stream (in `exchangePrices/sources/binance/`) emits the
 * generic `QuoteTick` and `ClosedBarTick` shapes shared with the
 * latency/reliability/data:capture pipelines. The trader's tracker
 * code wants the slightly older `LivePriceTick` /
 * `ClosedFiveMinuteBar` shapes, so this adapter renames the timestamp
 * fields and discards the `exchange` tag.
 *
 * Keeping the adapter as the *only* difference between the two
 * shapes means the WebSocket client itself, multi-asset routing, and
 * reconnect logic are owned in one place — the unified stream.
 */
export const binancePerpLivePriceSource: LivePriceSource = {
  id: "binance-perp",
  stream: ({
    assets,
    onTick,
    onBarClose,
    onConnect,
    onDisconnect,
    onError,
  }: LivePriceFeedParams): LivePriceFeedHandle => {
    const handle = streamBinancePerpQuotes({
      assets,
      onTick: (tick) => {
        onTick({
          asset: tick.asset,
          bid: tick.bid,
          ask: tick.ask,
          mid: tick.mid,
          exchangeTimeMs: tick.tsExchangeMs,
          receivedAtMs: tick.tsReceivedMs,
        });
      },
      onBarClose: (bar) => {
        onBarClose({
          asset: bar.asset,
          openTimeMs: bar.openTimeMs,
          closeTimeMs: bar.closeTimeMs,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
        });
      },
      onConnect,
      onDisconnect,
      onError: (error) => {
        onError?.(error);
      },
    });
    return { stop: handle.stop };
  },
  fetchRecentFiveMinuteBars,
  fetchExactFiveMinuteBar,
};
