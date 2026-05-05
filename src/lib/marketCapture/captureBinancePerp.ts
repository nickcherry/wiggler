import { binancePerpSymbol } from "@alea/lib/candles/sources/binance/binancePerpSymbol";
import { streamBinancePerpQuotes } from "@alea/lib/exchangePrices/sources/binance/streamBinancePerpQuotes";
import type { StreamHandle } from "@alea/lib/exchangePrices/types";
import type { CaptureSink } from "@alea/lib/marketCapture/captureSink";
import type { Asset } from "@alea/types/assets";

/**
 * Wires the unified Binance USDT-M perp quote stream into the capture
 * pipeline. Emits five `kind` flavours:
 *
 *   - `bbo` — every best-bid/ask update (the bookTicker stream)
 *   - `kline-close` — every closed 5m kline (price + OHLCV)
 *   - `connect` — every successful WS connect (incl. reconnects)
 *   - `disconnect` — every disconnect with a reason string
 *   - `error` — every WS error surfaced by the underlying client
 *
 * The source label is `binance-perp` regardless of asset; per-asset
 * separation lives in the `asset` column.
 */
export function captureBinancePerp({
  assets,
  sink,
}: {
  readonly assets: readonly Asset[];
  readonly sink: CaptureSink;
}): StreamHandle {
  return streamBinancePerpQuotes({
    assets,
    onTick: (tick) => {
      sink({
        tsMs: tick.tsExchangeMs ?? tick.tsReceivedMs,
        receivedMs: tick.tsReceivedMs,
        source: "binance-perp",
        asset: tick.asset,
        kind: "bbo",
        marketRef: binancePerpSymbol({ asset: tick.asset }),
        payload: {
          bid: tick.bid,
          ask: tick.ask,
          mid: tick.mid,
          tsExchangeMs: tick.tsExchangeMs,
        },
      });
    },
    onBarClose: (bar) => {
      sink({
        tsMs: bar.closeTimeMs,
        receivedMs: Date.now(),
        source: "binance-perp",
        asset: bar.asset,
        kind: "kline-close",
        marketRef: binancePerpSymbol({ asset: bar.asset }),
        payload: {
          openTimeMs: bar.openTimeMs,
          closeTimeMs: bar.closeTimeMs,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
        },
      });
    },
    onConnect: () => {
      const nowMs = Date.now();
      sink({
        tsMs: nowMs,
        receivedMs: nowMs,
        source: "binance-perp",
        asset: null,
        kind: "connect",
        marketRef: null,
        payload: {},
      });
    },
    onDisconnect: (reason) => {
      const nowMs = Date.now();
      sink({
        tsMs: nowMs,
        receivedMs: nowMs,
        source: "binance-perp",
        asset: null,
        kind: "disconnect",
        marketRef: null,
        payload: { reason },
      });
    },
    onError: (error) => {
      const nowMs = Date.now();
      sink({
        tsMs: nowMs,
        receivedMs: nowMs,
        source: "binance-perp",
        asset: null,
        kind: "error",
        marketRef: null,
        payload: { message: error.message },
      });
    },
  });
}
