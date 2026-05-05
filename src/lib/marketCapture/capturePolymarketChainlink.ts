import { streamPolymarketChainlinkQuotes } from "@alea/lib/exchangePrices/sources/polymarket/streamPolymarketChainlinkQuotes";
import type { StreamHandle } from "@alea/lib/exchangePrices/types";
import type { CaptureSink } from "@alea/lib/marketCapture/captureSink";
import type { Asset } from "@alea/types/assets";

/**
 * Wires Polymarket's Chainlink-derived RTDS reference price into the
 * capture pipeline. Chainlink is the actual settlement source for the
 * up/down 5m markets, so this is the most direct ground truth we can
 * record alongside Binance/Coinbase candles for proxy-mismatch
 * research. Source label: `polymarket-chainlink`.
 *
 * The underlying stream emits a `QuoteTick` per asset value update;
 * for a single-value reference we set bid=ask=mid=value, which the
 * downstream payload preserves.
 */
export function capturePolymarketChainlink({
  assets,
  sink,
}: {
  readonly assets: readonly Asset[];
  readonly sink: CaptureSink;
}): StreamHandle {
  return streamPolymarketChainlinkQuotes({
    assets,
    onTick: (tick) => {
      sink({
        tsMs: tick.tsExchangeMs ?? tick.tsReceivedMs,
        receivedMs: tick.tsReceivedMs,
        source: "polymarket-chainlink",
        asset: tick.asset,
        kind: "reference-price",
        marketRef: `${tick.asset}/usd`,
        payload: {
          value: tick.mid,
          tsExchangeMs: tick.tsExchangeMs,
        },
      });
    },
    onConnect: () => {
      const nowMs = Date.now();
      sink({
        tsMs: nowMs,
        receivedMs: nowMs,
        source: "polymarket-chainlink",
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
        source: "polymarket-chainlink",
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
        source: "polymarket-chainlink",
        asset: null,
        kind: "error",
        marketRef: null,
        payload: { message: error.message },
      });
    },
  });
}
