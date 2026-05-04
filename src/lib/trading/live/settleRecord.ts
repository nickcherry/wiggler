import type { ClosedFiveMinuteBar } from "@alea/lib/livePrices/types";
import { exactSettlementBar } from "@alea/lib/trading/live/freshness";
import type { AssetWindowRecord } from "@alea/lib/trading/live/types";
import { settleFilled } from "@alea/lib/trading/state/settleFilled";
import type { AssetWindowOutcome } from "@alea/lib/trading/telegram/formatWindowSummary";
import type { Asset } from "@alea/types/assets";

/**
 * Pure outcome computation for one asset's slot at window-end.
 * Reads the slot, derives the per-asset outcome the summary
 * formatter consumes, and returns the (possibly mutated) slot in
 * its terminal state. We keep mutation here rather than burying it
 * inside a "compute the summary string" function so the slot's
 * final kind (`settled` vs `noFill` vs unchanged) is observable for
 * tests and follow-up logic.
 *
 * Filled slots require the exact bar for this window. If the live line
 * is missing after a restart, the exact bar open is the safest
 * recoverable line; without the exact bar, wrap-up keeps the outcome
 * pending instead of booking guessed PnL.
 */
export function settleRecord({
  record,
  lastClosedBars,
}: {
  readonly record: AssetWindowRecord;
  readonly lastClosedBars: ReadonlyMap<Asset, ClosedFiveMinuteBar>;
}): AssetWindowOutcome {
  if (record.slot.kind === "empty") {
    return { asset: record.asset, kind: "none" };
  }
  if (record.slot.kind === "active") {
    if (record.slot.sharesFilled <= 0) {
      const settled = {
        kind: "noFill" as const,
        market: record.slot.market,
        side: record.slot.side,
        limitPrice: record.slot.limitPrice,
      };
      record.slot = settled;
      return {
        asset: record.asset,
        kind: "unfilled",
        side: settled.side,
        limitPrice: settled.limitPrice,
      };
    }
    const closedBar = exactSettlementBar({
      bar: lastClosedBars.get(record.asset),
      windowStartMs: record.slot.market.windowStartMs,
    });
    if (closedBar === null) {
      return {
        asset: record.asset,
        kind: "pending",
        side: record.slot.side,
        limitPrice: record.slot.limitPrice,
        reason: "missing-close",
      };
    }
    const line = record.line ?? closedBar.open;
    if (record.line === null) {
      record.line = line;
      record.lineCapturedAtMs = closedBar.openTimeMs;
    }
    const finalPrice = closedBar.close;
    const settled = settleFilled({
      active: record.slot,
      finalPrice,
      line,
    });
    record.slot = settled;
    if (settled.kind === "noFill") {
      return {
        asset: record.asset,
        kind: "unfilled",
        side: settled.side,
        limitPrice: settled.limitPrice,
      };
    }
    return {
      asset: record.asset,
      kind: "traded",
      side: settled.side,
      fillPrice: settled.fillPriceAvg,
      sharesFilled: settled.sharesFilled,
      costUsd: settled.costUsd,
      feesUsd: settled.feesUsd,
      netPnlUsd: settled.netPnlUsd,
      won: settled.won,
    };
  }
  if (record.slot.kind === "noFill") {
    return {
      asset: record.asset,
      kind: "unfilled",
      side: record.slot.side,
      limitPrice: record.slot.limitPrice,
    };
  }
  // `settled`
  return {
    asset: record.asset,
    kind: "traded",
    side: record.slot.side,
    fillPrice: record.slot.fillPriceAvg,
    sharesFilled: record.slot.sharesFilled,
    costUsd: record.slot.costUsd,
    feesUsd: record.slot.feesUsd,
    netPnlUsd: record.slot.netPnlUsd,
    won: record.slot.won,
  };
}
