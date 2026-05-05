import { coinbaseProductId } from "@alea/lib/candles/sources/coinbase/coinbaseProductId";
import {
  applyCoinbaseLevel2Frame,
  createCoinbaseLevel2State,
} from "@alea/lib/exchangePrices/sources/coinbase/applyCoinbaseLevel2Frame";
import type {
  StreamHandle,
  StreamQuotesParams,
} from "@alea/lib/exchangePrices/types";
import { createReconnectingWebSocket } from "@alea/lib/wsClient/createReconnectingWebSocket";
import type { Asset } from "@alea/types/assets";

const url = "wss://advanced-trade-ws.coinbase.com";

/**
 * Subscribes to the Coinbase Advanced Trade `level2` channel for one
 * or more `<asset>-USD` spot products. The previous `ticker` channel
 * only fired on trades (~2-5 Hz on BTC), so it lagged any BBO move
 * that wasn't accompanied by a print; the level2 channel fires on
 * every order-book change, giving us 50+ Hz on the same instrument.
 *
 * Defaults `assets` to `["btc"]` so the latency:capture experiments
 * keep working unchanged.
 *
 * Reliability: backed by `wsClient/createReconnectingWebSocket` —
 * auto-reconnect with backoff, stale-frame watchdog. On reconnect we
 * recreate the in-memory book and rely on Coinbase's post-subscribe
 * snapshot to repopulate it, so a dropped connection can't leave
 * stale levels lingering.
 */
export function streamCoinbaseSpotQuotes({
  assets = ["btc"],
  onTick,
  onError,
  onOpen,
  onClose,
  onConnect,
  onDisconnect,
}: StreamQuotesParams): StreamHandle {
  const productIdToAsset = buildProductIdMap({ assets });
  const productIds = [...productIdToAsset.keys()];
  let state = createCoinbaseLevel2State({ productIdToAsset });

  const handle = createReconnectingWebSocket({
    label: "coinbase-spot",
    url,
    onOpen: (ws) => {
      state = createCoinbaseLevel2State({ productIdToAsset });
      ws.send(
        JSON.stringify({
          type: "subscribe",
          channel: "level2",
          product_ids: productIds,
        }),
      );
      onOpen?.();
    },
    onConnect,
    onDisconnect,
    onError,
    onMessage: (raw) => {
      try {
        const ticks = applyCoinbaseLevel2Frame({
          raw,
          exchange: "coinbase-spot",
          state,
        });
        for (const tick of ticks) {
          onTick(tick);
        }
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });

  return {
    stop: async () => {
      await handle.stop();
      onClose?.();
    },
  };
}

function buildProductIdMap({
  assets,
}: {
  readonly assets: readonly Asset[];
}): ReadonlyMap<string, Asset> {
  const map = new Map<string, Asset>();
  for (const asset of assets) {
    map.set(coinbaseProductId({ asset }), asset);
  }
  return map;
}
