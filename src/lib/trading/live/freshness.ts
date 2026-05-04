import type { FiveMinuteAtrTracker } from "@alea/lib/livePrices/fiveMinuteAtrTracker";
import type { FiveMinuteEmaTracker } from "@alea/lib/livePrices/fiveMinuteEmaTracker";
import { FIVE_MINUTES_MS } from "@alea/lib/livePrices/fiveMinuteWindow";
import type {
  ClosedFiveMinuteBar,
  LivePriceTick,
} from "@alea/lib/livePrices/types";
import type { UpDownBook } from "@alea/lib/trading/vendor/types";

export const MAX_LIVE_TICK_AGE_MS = 2_000;
export const MAX_LINE_CAPTURE_LAG_MS = 5_000;
export const MAX_BOOK_AGE_MS = 3_000;

export function tickReferenceMs({
  tick,
}: {
  readonly tick: LivePriceTick;
}): number {
  return tick.exchangeTimeMs ?? tick.receivedAtMs;
}

export function tickIsFresh({
  tick,
  windowStartMs,
  nowMs,
}: {
  readonly tick: LivePriceTick;
  readonly windowStartMs: number;
  readonly nowMs: number;
}): boolean {
  if (tickReferenceMs({ tick }) < windowStartMs) {
    return false;
  }
  if (tick.receivedAtMs > nowMs + 1_000) {
    return false;
  }
  return nowMs - tick.receivedAtMs <= MAX_LIVE_TICK_AGE_MS;
}

export function tickCanCaptureLine({
  tick,
  windowStartMs,
  nowMs,
}: {
  readonly tick: LivePriceTick;
  readonly windowStartMs: number;
  readonly nowMs: number;
}): boolean {
  if (!tickIsFresh({ tick, windowStartMs, nowMs })) {
    return false;
  }
  return tickReferenceMs({ tick }) <= windowStartMs + MAX_LINE_CAPTURE_LAG_MS;
}

export function usableBookForMarket({
  book,
  vendorRef,
  windowStartMs,
  nowMs,
}: {
  readonly book: UpDownBook | undefined;
  readonly vendorRef: string;
  readonly windowStartMs: number;
  readonly nowMs: number;
}): UpDownBook | null {
  if (book === undefined) {
    return null;
  }
  if (book.market.vendorRef !== vendorRef) {
    return null;
  }
  if (book.fetchedAtMs < windowStartMs) {
    return null;
  }
  if (book.fetchedAtMs > nowMs + 1_000) {
    return null;
  }
  if (nowMs - book.fetchedAtMs > MAX_BOOK_AGE_MS) {
    return null;
  }
  return book;
}

export function emaReadyForWindow({
  tracker,
  windowStartMs,
}: {
  readonly tracker: FiveMinuteEmaTracker;
  readonly windowStartMs: number;
}): number | null {
  const ema = tracker.currentValue();
  if (ema === null) {
    return null;
  }
  if (tracker.lastBarOpenMs() !== windowStartMs - FIVE_MINUTES_MS) {
    return null;
  }
  return ema;
}

/**
 * Sister of `emaReadyForWindow` for the configured live ATR tracker. Returns the
 * tracker's current value only if the last bar incorporated is the
 * one ending exactly at the current window's start — same staleness
 * rule as EMA, so the live filter classification matches the
 * "evaluated through and including the prior closed bar" convention
 * the training pipeline uses.
 */
export function atrReadyForWindow({
  tracker,
  windowStartMs,
}: {
  readonly tracker: FiveMinuteAtrTracker;
  readonly windowStartMs: number;
}): number | null {
  const atr = tracker.currentValue();
  if (atr === null) {
    return null;
  }
  if (tracker.lastBarOpenMs() !== windowStartMs - FIVE_MINUTES_MS) {
    return null;
  }
  return atr;
}

export function exactSettlementBar({
  bar,
  windowStartMs,
}: {
  readonly bar: ClosedFiveMinuteBar | undefined;
  readonly windowStartMs: number;
}): ClosedFiveMinuteBar | null {
  if (bar === undefined || bar.openTimeMs !== windowStartMs) {
    return null;
  }
  return bar;
}
