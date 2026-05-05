import { coinbasePerpProductId } from "@alea/lib/candles/sources/coinbase/coinbasePerpProductId";
import { coinbaseProductId } from "@alea/lib/candles/sources/coinbase/coinbaseProductId";
import { streamCoinbasePerpQuotes } from "@alea/lib/exchangePrices/sources/coinbase/streamCoinbasePerpQuotes";
import { streamCoinbaseSpotQuotes } from "@alea/lib/exchangePrices/sources/coinbase/streamCoinbaseSpotQuotes";
import type { StreamHandle } from "@alea/lib/exchangePrices/types";
import type { CaptureSink } from "@alea/lib/marketCapture/captureSink";
import type { Asset } from "@alea/types/assets";

type CoinbaseProduct = "spot" | "perp";

/**
 * Wires the unified Coinbase Advanced Trade `level2` stream — either
 * spot or perp — into the capture pipeline. Both products share the
 * same WS endpoint and frame protocol; the only difference at this
 * layer is the product-id naming and the `source` label
 * (`coinbase-spot` vs `coinbase-perp`).
 *
 * Like the Binance wrapper, this only emits when the BBO actually
 * moves — the underlying L2 book maintenance lives in
 * `applyCoinbaseLevel2Frame`.
 */
function captureCoinbase({
  product,
  assets,
  sink,
}: {
  readonly product: CoinbaseProduct;
  readonly assets: readonly Asset[];
  readonly sink: CaptureSink;
}): StreamHandle {
  const source = product === "perp" ? "coinbase-perp" : "coinbase-spot";
  const productIdFor =
    product === "perp"
      ? (asset: Asset) => coinbasePerpProductId({ asset })
      : (asset: Asset) => coinbaseProductId({ asset });
  const start =
    product === "perp" ? streamCoinbasePerpQuotes : streamCoinbaseSpotQuotes;

  return start({
    assets,
    onTick: (tick) => {
      sink({
        tsMs: tick.tsExchangeMs ?? tick.tsReceivedMs,
        receivedMs: tick.tsReceivedMs,
        source,
        asset: tick.asset,
        kind: "bbo",
        marketRef: productIdFor(tick.asset),
        payload: {
          bid: tick.bid,
          ask: tick.ask,
          mid: tick.mid,
          tsExchangeMs: tick.tsExchangeMs,
        },
      });
    },
    onConnect: () => {
      const nowMs = Date.now();
      sink({
        tsMs: nowMs,
        receivedMs: nowMs,
        source,
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
        source,
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
        source,
        asset: null,
        kind: "error",
        marketRef: null,
        payload: { message: error.message },
      });
    },
  });
}

export function captureCoinbasePerp({
  assets,
  sink,
}: {
  readonly assets: readonly Asset[];
  readonly sink: CaptureSink;
}): StreamHandle {
  return captureCoinbase({ product: "perp", assets, sink });
}

export function captureCoinbaseSpot({
  assets,
  sink,
}: {
  readonly assets: readonly Asset[];
  readonly sink: CaptureSink;
}): StreamHandle {
  return captureCoinbase({ product: "spot", assets, sink });
}
