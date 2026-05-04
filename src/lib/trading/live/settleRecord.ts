import type { ClosedFiveMinuteBar } from "@alea/lib/livePrices/types";
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
 * If a record has an `active` slot but never captured a `line` price
 * (degenerate case: no live tick during the entire window), the
 * outcome is reported as `unfilled` — without a line we can't
 * compute won/lost, so the runner declines to attribute PnL rather
 * than booking a phantom loss.
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
    if (record.line === null) {
      return {
        asset: record.asset,
        kind: "unfilled",
        side: record.slot.side,
        limitPrice: record.slot.limitPrice,
      };
    }
    const closedBar = lastClosedBars.get(record.asset);
    const finalPrice = closedBar?.close ?? record.line;
    const settled = settleFilled({
      active: record.slot,
      finalPrice,
      line: record.line,
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
