import type { FiveMinuteAtrTracker } from "@alea/lib/livePrices/fiveMinuteAtrTracker";
import type { FiveMinuteEmaTracker } from "@alea/lib/livePrices/fiveMinuteEmaTracker";
import type { LivePriceTick } from "@alea/lib/livePrices/types";
import { evaluateDecision } from "@alea/lib/trading/decision/evaluateDecision";
import type { TradeDecision } from "@alea/lib/trading/decision/types";
import {
  atrReadyForWindow,
  emaReadyForWindow,
  tickIsFresh,
  usableBookForMarket,
} from "@alea/lib/trading/live/freshness";
import type {
  AssetWindowRecord,
  BookCache,
  WindowRecord,
} from "@alea/lib/trading/live/types";
import type { ProbabilityTable } from "@alea/lib/trading/types";
import type { Asset } from "@alea/types/assets";

export function evaluateRecordDecision({
  asset,
  record,
  window,
  lastTick,
  emas,
  atrs,
  books,
  table,
  minEdge,
  nowMs,
}: {
  readonly asset: Asset;
  readonly record: AssetWindowRecord;
  readonly window: Pick<WindowRecord, "windowStartMs">;
  readonly lastTick: ReadonlyMap<Asset, LivePriceTick>;
  readonly emas: ReadonlyMap<Asset, FiveMinuteEmaTracker>;
  readonly atrs: ReadonlyMap<Asset, FiveMinuteAtrTracker>;
  readonly books: BookCache;
  readonly table: ProbabilityTable;
  readonly minEdge: number;
  readonly nowMs: number;
}): TradeDecision | null {
  const market = record.market;
  if (
    market === null ||
    record.hydrationStatus !== "ready" ||
    record.line === null
  ) {
    return null;
  }
  const tick = lastTick.get(asset);
  const tracker = emas.get(asset);
  const atrTracker = atrs.get(asset);
  if (tick === undefined || tracker === undefined || atrTracker === undefined) {
    return null;
  }
  if (!tickIsFresh({ tick, windowStartMs: window.windowStartMs, nowMs })) {
    return null;
  }
  const ema50 = emaReadyForWindow({
    tracker,
    windowStartMs: window.windowStartMs,
  });
  const atr14 = atrReadyForWindow({
    tracker: atrTracker,
    windowStartMs: window.windowStartMs,
  });
  if (atr14 === null) {
    return null;
  }
  const book = usableBookForMarket({
    book: books.get(market.vendorRef),
    vendorRef: market.vendorRef,
    windowStartMs: market.windowStartMs,
    nowMs,
  });
  return evaluateDecision({
    asset,
    windowStartMs: window.windowStartMs,
    nowMs,
    line: record.line,
    currentPrice: tick.mid,
    ema50,
    atr14,
    upBestBid: book?.up.bestBid ?? null,
    downBestBid: book?.down.bestBid ?? null,
    upTokenId: market.upRef,
    downTokenId: market.downRef,
    table,
    minEdge,
  });
}
