import { fetchExactFiveMinuteBar } from "@alea/lib/livePrices/binancePerp/fetchRecentFiveMinuteBars";
import type { ClosedFiveMinuteBar } from "@alea/lib/livePrices/types";
import { sendTelegramMessage } from "@alea/lib/telegram/sendTelegramMessage";
import { settleRecord } from "@alea/lib/trading/live/settleRecord";
import type {
  ConditionIndex,
  LifetimePnlBox,
  LiveEvent,
  WindowRecord,
} from "@alea/lib/trading/live/types";
import { persistLifetimePnl } from "@alea/lib/trading/state/lifetimePnlStore";
import {
  type AssetWindowOutcome,
  formatWindowSummary,
} from "@alea/lib/trading/telegram/formatWindowSummary";
import type { Asset } from "@alea/types/assets";

const SETTLEMENT_RETRY_DELAY_MS = 2_000;

type WrapUpWindowParams = {
  readonly window: WindowRecord;
  readonly lastClosedBars: Map<Asset, ClosedFiveMinuteBar>;
  readonly telegramBotToken: string;
  readonly telegramChatId: string;
  readonly windowsAll: Map<number, WindowRecord>;
  readonly conditionIdIndex: ConditionIndex;
  readonly lifetimePnl: LifetimePnlBox;
  readonly walletAddress: string;
  readonly emit: (event: LiveEvent) => void;
};

/**
 * End-of-window pipeline:
 *   1. Settle every per-asset record into its terminal slot, building
 *      the per-asset outcome list.
 *   2. Roll the window's net PnL into the lifetime accumulator.
 *   3. Persist the new lifetime total to the on-disk checkpoint.
 *      Failures here are logged but don't block the summary.
 *   4. Format the Telegram body and ship it (await — the summary is
 *      the user-facing artifact for the window).
 *   5. Drop the window from the runner's bookkeeping.
 */
export async function wrapUpWindow(
  params: WrapUpWindowParams,
): Promise<void> {
  const {
    window,
    lastClosedBars,
    telegramBotToken,
    telegramChatId,
    windowsAll,
    conditionIdIndex,
    lifetimePnl,
    walletAddress,
    emit,
  } = params;
  if (window.summarySent) {
    return;
  }

  await hydrateMissingSettlementBars({ window, lastClosedBars, emit });

  const outcomes: AssetWindowOutcome[] = [];
  for (const record of window.perAsset.values()) {
    outcomes.push(settleRecord({ record, lastClosedBars }));
  }
  const pending = outcomes.filter((o) => o.kind === "pending");
  if (pending.length > 0) {
    window.settlementRetryCount += 1;
    emit({
      kind: "warn",
      atMs: Date.now(),
      message: `window ${new Date(window.windowStartMs).toISOString().slice(11, 16)} settlement pending for ${pending.map((p) => p.asset.toUpperCase()).join(",")}; retry #${window.settlementRetryCount}`,
    });
    window.wrapUpTimer = setTimeout(() => {
      window.wrapUpTimer = null;
      void wrapUpWindow(params);
    }, SETTLEMENT_RETRY_DELAY_MS);
    return;
  }
  window.summarySent = true;

  const windowPnl = outcomes.reduce(
    (acc, o) => acc + (o.kind === "traded" ? o.netPnlUsd : 0),
    0,
  );
  lifetimePnl.value += windowPnl;

  // Persist BEFORE Telegram so a crash between settle and notify
  // still preserves the new total. A persist failure is non-fatal.
  try {
    await persistLifetimePnl({
      walletAddress,
      lifetimePnlUsd: lifetimePnl.value,
    });
  } catch (error) {
    emit({
      kind: "warn",
      atMs: Date.now(),
      message: `lifetime pnl persist failed: ${(error as Error).message}`,
    });
  }

  const body = formatWindowSummary({
    outcomes,
    stats: {
      rejectedCount: window.rejectedCount,
      placedAfterRetryCount: window.placedAfterRetryCount,
    },
    totalPnlUsd: lifetimePnl.value,
  });
  emit({
    kind: "window-summary",
    atMs: Date.now(),
    windowStartMs: window.windowStartMs,
    windowEndMs: window.windowEndMs,
    body,
  });

  try {
    await sendTelegramMessage({
      botToken: telegramBotToken,
      chatId: telegramChatId,
      text: body,
    });
  } catch (error) {
    emit({
      kind: "warn",
      atMs: Date.now(),
      message: `window summary telegram send failed: ${(error as Error).message}`,
    });
  }

  for (const record of window.perAsset.values()) {
    if (record.market !== null) {
      conditionIdIndex.delete(record.market.vendorRef);
    }
  }
  windowsAll.delete(window.windowStartMs);
}

async function hydrateMissingSettlementBars({
  window,
  lastClosedBars,
  emit,
}: {
  readonly window: WindowRecord;
  readonly lastClosedBars: Map<Asset, ClosedFiveMinuteBar>;
  readonly emit: (event: LiveEvent) => void;
}): Promise<void> {
  const missing = new Map<Asset, number>();
  for (const record of window.perAsset.values()) {
    const slot = record.slot;
    if (slot.kind !== "active" || slot.sharesFilled <= 0) {
      continue;
    }
    const existing = lastClosedBars.get(record.asset);
    const openTimeMs = slot.market.windowStartMs;
    if (existing?.openTimeMs !== openTimeMs) {
      missing.set(record.asset, openTimeMs);
    }
  }
  await Promise.all(
    [...missing].map(async ([asset, openTimeMs]) => {
      try {
        const exact = await fetchExactFiveMinuteBar({ asset, openTimeMs });
        if (exact !== null) {
          lastClosedBars.set(asset, exact);
        }
      } catch (error) {
        emit({
          kind: "warn",
          atMs: Date.now(),
          message: `${asset.toUpperCase()} settlement bar refresh failed: ${(error as Error).message}`,
        });
      }
    }),
  );
}
