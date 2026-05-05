import type { CaptureSink } from "@alea/lib/marketCapture/captureSink";
import { streamPolymarketMarketData } from "@alea/lib/trading/vendor/polymarket/streamMarketData";
import type {
  MarketDataEvent,
  MarketDataStreamHandle,
  TradableMarket,
} from "@alea/lib/trading/vendor/types";

/**
 * Wires the Polymarket market-data WS into the capture pipeline. The
 * `markets` set is window-scoped (Polymarket's up/down 5m markets get
 * their own condition id per window), so the runner is expected to
 * `stop()` and re-create this whenever the active set changes — the
 * same pattern the trading runner uses.
 *
 * Source label: `polymarket`. Each emitted record's `kind` mirrors
 * the venue's event kind (`book`, `trade`, `price-change`,
 * `tick-size-change`, `resolved`) plus the synthetic markers
 * `connect`, `disconnect`, `error`, and `resync`.
 *
 * `resync` is emitted on each reconnect after the first connect of
 * this stream's lifetime — research code replaying the tape needs
 * an explicit signal to reset book state, otherwise late-arriving
 * book diffs from a prior connection could be applied on top of a
 * stale book and silently corrupt the replay.
 */
export function capturePolymarket({
  markets,
  sink,
}: {
  readonly markets: readonly TradableMarket[];
  readonly sink: CaptureSink;
}): MarketDataStreamHandle {
  let connectsSeen = 0;

  const tokenIdToMarket = new Map<string, TradableMarket>();
  for (const market of markets) {
    tokenIdToMarket.set(market.upRef, market);
    tokenIdToMarket.set(market.downRef, market);
  }

  const marketRefForEvent = (
    event: MarketDataEvent,
  ): { vendorRef: string | null; asset: string | null } => {
    // Trades + book + bbo + price-change + tick-size all carry an
    // outcomeRef; we look up the asset/market from that. `resolved`
    // events carry the vendorRef directly.
    if (event.kind === "resolved") {
      return { vendorRef: event.vendorRef, asset: null };
    }
    const tokenId =
      "outcomeRef" in event && event.outcomeRef !== null
        ? event.outcomeRef
        : null;
    if (tokenId === null) {
      return { vendorRef: event.vendorRef, asset: null };
    }
    const market = tokenIdToMarket.get(tokenId);
    if (market === undefined) {
      return { vendorRef: event.vendorRef, asset: null };
    }
    return { vendorRef: market.vendorRef, asset: market.asset };
  };

  return streamPolymarketMarketData({
    markets,
    onEvent: (event) => {
      const { vendorRef, asset } = marketRefForEvent(event);
      sink({
        tsMs: event.atMs,
        receivedMs: Date.now(),
        source: "polymarket",
        asset,
        kind: event.kind,
        marketRef: vendorRef,
        payload: { ...event },
      });
    },
    onConnect: () => {
      const nowMs = Date.now();
      connectsSeen += 1;
      sink({
        tsMs: nowMs,
        receivedMs: nowMs,
        source: "polymarket",
        asset: null,
        kind: "connect",
        marketRef: null,
        payload: { sequence: connectsSeen },
      });
      // Replay-side discipline: the second-and-later connects mark a
      // re-subscription, after which book state must be reset before
      // applying any subsequent diffs.
      if (connectsSeen > 1) {
        sink({
          tsMs: nowMs,
          receivedMs: nowMs,
          source: "polymarket",
          asset: null,
          kind: "resync",
          marketRef: null,
          payload: { reason: "reconnect", sequence: connectsSeen },
        });
      }
    },
    onDisconnect: (reason) => {
      const nowMs = Date.now();
      sink({
        tsMs: nowMs,
        receivedMs: nowMs,
        source: "polymarket",
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
        source: "polymarket",
        asset: null,
        kind: "error",
        marketRef: null,
        payload: { message: error.message },
      });
    },
  });
}
