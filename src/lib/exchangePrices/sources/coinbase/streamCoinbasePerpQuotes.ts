import { coinbasePerpProductId } from "@alea/lib/candles/sources/coinbase/coinbasePerpProductId";
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
 * or more `<asset>-PERP-INTX` perpetual products on Coinbase
 * International. Same level2 maintenance protocol as spot — emits a
 * `QuoteTick` only when an asset's BBO actually moves.
 *
 * Defaults `assets` to `["btc"]` so legacy single-asset callers
 * (latency:capture experiments etc.) keep working unchanged. Long-
 * running consumers (data:capture, etc.) should always pass the
 * full asset list.
 *
 * Reliability: backed by `wsClient/createReconnectingWebSocket` —
 * auto-reconnect with backoff, stale-frame watchdog. On reconnect,
 * the L2 subscription is re-sent and Coinbase replies with a fresh
 * snapshot, so the in-memory book correctly resets via the same
 * `applyCoinbaseLevel2Frame` path. (We deliberately recreate the
 * state on each reconnect so any partial book left over from the
 * dropped connection is discarded.)
 */
export function streamCoinbasePerpQuotes({
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
    label: "coinbase-perp",
    url,
    onOpen: (ws) => {
      // Reset in-memory book on every (re)connect — the level2
      // channel sends a fresh snapshot on subscribe, so mixing the
      // pre-disconnect state with post-snapshot updates would corrupt
      // the depth tracker.
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
          exchange: "coinbase-perp",
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
    map.set(coinbasePerpProductId({ asset }), asset);
  }
  return map;
}
