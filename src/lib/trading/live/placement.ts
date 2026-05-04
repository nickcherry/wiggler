import { ORDER_CANCEL_MARGIN_MS, STAKE_USD } from "@alea/constants/trading";
import type { FiveMinuteEmaTracker } from "@alea/lib/livePrices/fiveMinuteEmaTracker";
import type { LivePriceTick } from "@alea/lib/livePrices/types";
import { sendTelegramMessage } from "@alea/lib/telegram/sendTelegramMessage";
import { evaluateDecision } from "@alea/lib/trading/decision/evaluateDecision";
import type {
  AssetWindowRecord,
  BookCache,
  LiveEvent,
  WindowRecord,
} from "@alea/lib/trading/live/types";
import { labelAsset, sleep } from "@alea/lib/trading/live/utils";
import { formatOrderError } from "@alea/lib/trading/telegram/formatOrderError";
import { formatOrderPlaced } from "@alea/lib/trading/telegram/formatOrderPlaced";
import type { ProbabilityTable } from "@alea/lib/trading/types";
import type { LeadingSide } from "@alea/lib/trading/types";
import {
  type PlacedOrder,
  PostOnlyRejectionError,
  type Vendor,
} from "@alea/lib/trading/vendor/types";
import type { Asset } from "@alea/types/assets";

const PLACE_RETRY_DELAY_MS = 250;
const PLACE_GIVE_UP_BEFORE_END_MS = ORDER_CANCEL_MARGIN_MS + 1_000;

/**
 * Places one maker-only limit BUY for `record`'s asset, with the
 * full chunk-2-review error handling policy:
 *
 *   - **postOnly rejection** (price moved between book read and post):
 *     silent on Telegram, increments `window.rejectedCount`. The loop
 *     refreshes the book against the venue, re-evaluates the decision,
 *     and tries again. Stops when the edge drops below `minEdge`, the
 *     slot fills, or we're within the cancel margin of window close.
 *   - **Generic error** (network, signing, venue 5xx): one silent
 *     retry with the same parameters. If the second attempt also
 *     fails, fire-and-forget a Telegram alert and give up.
 *
 * The slot is held in the `active` placeholder state for the entire
 * loop so the tick handler doesn't double-fire placement while we're
 * iterating. Successful placement sends a Telegram alert
 * (`order-placed` log event + the human-readable message).
 */
export async function placeWithRetry({
  asset,
  vendor,
  record,
  window,
  lastTick,
  emas,
  books,
  table,
  minEdge,
  telegramBotToken,
  telegramChatId,
  signal,
  emit,
}: {
  readonly asset: Asset;
  readonly vendor: Vendor;
  readonly record: AssetWindowRecord;
  readonly window: WindowRecord;
  readonly lastTick: ReadonlyMap<Asset, LivePriceTick>;
  readonly emas: ReadonlyMap<Asset, FiveMinuteEmaTracker>;
  readonly books: BookCache;
  readonly table: ProbabilityTable;
  readonly minEdge: number;
  readonly telegramBotToken: string;
  readonly telegramChatId: string;
  readonly signal: AbortSignal;
  readonly emit: (event: LiveEvent) => void;
}): Promise<void> {
  let postOnlyRetries = 0;

  while (true) {
    if (signal.aborted) {
      record.slot = { kind: "empty" };
      return;
    }
    if (Date.now() >= window.windowEndMs - PLACE_GIVE_UP_BEFORE_END_MS) {
      record.slot = { kind: "empty" };
      return;
    }
    const market = record.market;
    if (market === null || !market.acceptingOrders) {
      record.slot = { kind: "empty" };
      return;
    }
    const decision = currentDecision({
      asset,
      record,
      window,
      lastTick,
      emas,
      books,
      table,
      minEdge,
    });
    if (decision === null) {
      record.slot = { kind: "empty" };
      return;
    }

    // Reflect the freshly re-evaluated side/price on the placeholder
    // slot so log/UI events reading the slot mid-loop see truth.
    record.slot = {
      kind: "active",
      market,
      side: decision.side,
      outcomeRef: decision.outcomeRef,
      orderId: null,
      limitPrice: decision.bid,
      sharesIfFilled: 0,
      sharesFilled: 0,
      costUsd: 0,
      feeRateBpsAvg: 0,
    };

    let attempt = await attemptPlace({
      vendor,
      market,
      side: decision.side,
      bid: decision.bid,
    });
    // One silent retry for generic errors with identical params.
    if (attempt.kind === "generic") {
      await sleep(PLACE_RETRY_DELAY_MS);
      attempt = await attemptPlace({
        vendor,
        market,
        side: decision.side,
        bid: decision.bid,
      });
    }

    if (attempt.kind === "ok") {
      record.slot = {
        kind: "active",
        market,
        side: attempt.placed.side,
        outcomeRef: attempt.placed.outcomeRef,
        orderId: attempt.placed.orderId,
        limitPrice: attempt.placed.limitPrice,
        sharesIfFilled: attempt.placed.sharesIfFilled,
        sharesFilled: 0,
        costUsd: 0,
        feeRateBpsAvg: attempt.placed.feeRateBps,
      };
      if (postOnlyRetries > 0) {
        window.placedAfterRetryCount += 1;
      }
      emit({
        kind: "order-placed",
        atMs: Date.now(),
        asset,
        slot: record.slot,
      });
      const tick = lastTick.get(asset);
      const underlyingPrice =
        tick?.mid ?? record.line ?? attempt.placed.limitPrice;
      const linePrice = record.line ?? underlyingPrice;
      sendTelegramFireAndForget({
        botToken: telegramBotToken,
        chatId: telegramChatId,
        text: formatOrderPlaced({
          asset,
          side: attempt.placed.side,
          stakeUsd: STAKE_USD,
          underlyingPrice,
          linePrice,
          windowEndMs: window.windowEndMs,
          nowMs: Date.now(),
        }),
        emit,
        context: `${labelAsset(asset)} placement alert`,
      });
      return;
    }

    if (attempt.kind === "postOnly") {
      window.rejectedCount += 1;
      postOnlyRetries += 1;
      emit({
        kind: "info",
        atMs: Date.now(),
        message: `${labelAsset(asset)} postOnly rejection (#${postOnlyRetries}) at ${decision.bid.toFixed(2)} — ${attempt.errorMessage}`,
      });
      // Force a fresh book against the venue so the next pass
      // evaluates against the moved spread, not the stale poll.
      try {
        const fresh = await vendor.fetchBook({ market, signal });
        books.set(asset, fresh);
      } catch {
        // Carry on with whatever the poll has.
      }
      await sleep(PLACE_RETRY_DELAY_MS);
      continue;
    }

    // Generic, after retry — give up + Telegram.
    record.slot = { kind: "empty" };
    emit({
      kind: "error",
      atMs: Date.now(),
      message: `${labelAsset(asset)} place failed (after retry): ${attempt.errorMessage}`,
    });
    sendTelegramFireAndForget({
      botToken: telegramBotToken,
      chatId: telegramChatId,
      text: formatOrderError({
        asset,
        side: decision.side,
        errorMessage: attempt.errorMessage,
      }),
      emit,
      context: `${labelAsset(asset)} order-error alert`,
    });
    return;
  }
}

type CurrentDecision = {
  readonly side: LeadingSide;
  readonly outcomeRef: string;
  readonly bid: number;
};

function currentDecision({
  asset,
  record,
  window,
  lastTick,
  emas,
  books,
  table,
  minEdge,
}: {
  readonly asset: Asset;
  readonly record: AssetWindowRecord;
  readonly window: WindowRecord;
  readonly lastTick: ReadonlyMap<Asset, LivePriceTick>;
  readonly emas: ReadonlyMap<Asset, FiveMinuteEmaTracker>;
  readonly books: ReadonlyMap<
    Asset,
    { up: { bestBid: number | null }; down: { bestBid: number | null } }
  >;
  readonly table: ProbabilityTable;
  readonly minEdge: number;
}): CurrentDecision | null {
  const market = record.market;
  if (market === null || record.line === null) {
    return null;
  }
  const tick = lastTick.get(asset);
  const tracker = emas.get(asset);
  if (tick === undefined || tracker === undefined) {
    return null;
  }
  const book = books.get(asset);
  const decision = evaluateDecision({
    asset,
    windowStartMs: window.windowStartMs,
    nowMs: Date.now(),
    line: record.line,
    currentPrice: tick.mid,
    ema50: tracker.currentValue(),
    upBestBid: book?.up.bestBid ?? null,
    downBestBid: book?.down.bestBid ?? null,
    upTokenId: market.upRef,
    downTokenId: market.downRef,
    table,
    minEdge,
  });
  if (decision.kind !== "trade" || decision.chosen.bid === null) {
    return null;
  }
  return {
    side: decision.chosen.side,
    outcomeRef: decision.chosen.tokenId,
    bid: decision.chosen.bid,
  };
}

type PlaceAttempt =
  | { readonly kind: "ok"; readonly placed: PlacedOrder }
  | { readonly kind: "postOnly"; readonly errorMessage: string }
  | { readonly kind: "generic"; readonly errorMessage: string };

async function attemptPlace({
  vendor,
  market,
  side,
  bid,
}: {
  readonly vendor: Vendor;
  readonly market: AssetWindowRecord["market"] & object;
  readonly side: LeadingSide;
  readonly bid: number;
}): Promise<PlaceAttempt> {
  try {
    const placed = await vendor.placeMakerLimitBuy({
      market,
      side,
      limitPrice: bid,
      stakeUsd: STAKE_USD,
    });
    return { kind: "ok", placed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof PostOnlyRejectionError) {
      return { kind: "postOnly", errorMessage: message };
    }
    return { kind: "generic", errorMessage: message };
  }
}

/**
 * Telegram is on the operator-experience hot path, not the trading
 * hot path. Send it without awaiting; surface failures as a `warn`
 * log line so the operator notices but the trading loop keeps
 * moving.
 */
export function sendTelegramFireAndForget({
  botToken,
  chatId,
  text,
  emit,
  context,
}: {
  readonly botToken: string;
  readonly chatId: string;
  readonly text: string;
  readonly emit: (event: LiveEvent) => void;
  readonly context: string;
}): void {
  void sendTelegramMessage({ botToken, chatId, text }).catch((error) => {
    emit({
      kind: "warn",
      atMs: Date.now(),
      message: `${context} send failed: ${(error as Error).message}`,
    });
  });
}
