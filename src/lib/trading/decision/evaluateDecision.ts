import { flooredRemainingMinutes } from "@alea/lib/livePrices/fiveMinuteWindow";
import type {
  DecisionSnapshot,
  SideEdge,
  TradeDecision,
} from "@alea/lib/trading/decision/types";
import { lookupProbability } from "@alea/lib/trading/lookupProbability";
import type { LeadingSide, ProbabilityTable } from "@alea/lib/trading/types";
import type { Asset } from "@alea/types/assets";

export type DecisionInputs = {
  readonly asset: Asset;
  readonly windowStartMs: number;
  readonly nowMs: number;
  readonly line: number;
  readonly currentPrice: number;
  /**
   * Most recent EMA-50 evaluated *through and including* the last
   * CLOSED 5m bar — i.e. the "EMA just before the current window
   * started" the training pipeline conditions on. `null` when the
   * tracker is still warming up (fewer than 50 closed bars seen).
   */
  readonly ema50: number | null;
  /** Best bid for the up-YES token, or `null` if nothing is resting. */
  readonly upBestBid: number | null;
  /** Best bid for the down-YES token, or `null` if nothing is resting. */
  readonly downBestBid: number | null;
  readonly upTokenId: string;
  readonly downTokenId: string;
  readonly table: ProbabilityTable;
  readonly minEdge: number;
};

/**
 * Pure decision evaluator. Given a fully-materialized snapshot from
 * the live feeds and the committed probability table, returns a
 * `TradeDecision` that the dry-run logger or the live-runner can act
 * on without further branching.
 *
 * Decision rules:
 *
 *   1. Floor `(now - windowStart)` to one of {1,2,3,4} minutes
 *      remaining. Out-of-window or pre-window → skip.
 *   2. EMA-50 not seeded → skip (`warmup`). The bot doesn't trade on
 *      regime data it doesn't yet have.
 *   3. Compute current side, distance, and EMA-50 alignment;
 *      look up the probability table bucket. Missing bucket (very-far-
 *      from-line tail) → skip (`no-bucket`).
 *   4. Compute per-side edges. Buying the up-YES at its best bid pays
 *      out 1 USDC if up wins, so `edge_up = ourP_up − bid_up`.
 *      Symmetrically for down. We always quote against bids because
 *      we are exclusively maker (chunk 3); buying at the ask is a
 *      taker fill we never want.
 *   5. Pick the side with the larger edge. If neither side has a bid
 *      → skip (`no-bid`); if the chosen edge is below `minEdge` →
 *      skip (`thin-edge`).
 *   6. Otherwise: trade.
 *
 * The skip variants always carry as much diagnostic data as is
 * available at the point of bail-out, so the dry-run log can show
 * exactly what edge we passed up.
 */
export function evaluateDecision(inputs: DecisionInputs): TradeDecision {
  const remaining = flooredRemainingMinutes({
    windowStartMs: inputs.windowStartMs,
    nowMs: inputs.nowMs,
  });
  if (remaining === null) {
    return {
      kind: "skip",
      reason: "out-of-window",
      snapshot: null,
      samples: null,
      up: null,
      down: null,
    };
  }
  if (inputs.ema50 === null) {
    return {
      kind: "skip",
      reason: "warmup",
      snapshot: null,
      samples: null,
      up: null,
      down: null,
    };
  }

  const distanceBp = Math.floor(
    (Math.abs(inputs.currentPrice - inputs.line) / inputs.line) * 10_000 + 1e-9,
  );
  const currentSide: LeadingSide =
    inputs.currentPrice >= inputs.line ? "up" : "down";
  const regime: LeadingSide = inputs.line >= inputs.ema50 ? "up" : "down";
  const aligned = currentSide === regime;

  const snapshot: DecisionSnapshot = {
    asset: inputs.asset,
    windowStartMs: inputs.windowStartMs,
    nowMs: inputs.nowMs,
    line: inputs.line,
    currentPrice: inputs.currentPrice,
    distanceBp,
    remaining,
    ema50: inputs.ema50,
    regime,
    currentSide,
    aligned,
  };

  const lookup = lookupProbability({
    table: inputs.table,
    asset: inputs.asset,
    aligned,
    remaining,
    distanceBp,
  });
  if (lookup === null) {
    return {
      kind: "skip",
      reason: "no-bucket",
      snapshot,
      samples: null,
      up: null,
      down: null,
    };
  }

  const ourProbCurrent = lookup.probability;
  const ourProbOther = 1 - ourProbCurrent;
  const ourProbUp = currentSide === "up" ? ourProbCurrent : ourProbOther;
  const ourProbDown = currentSide === "down" ? ourProbCurrent : ourProbOther;

  const up: SideEdge = {
    side: "up",
    tokenId: inputs.upTokenId,
    bid: inputs.upBestBid,
    ourProbability: ourProbUp,
    edge: inputs.upBestBid === null ? null : ourProbUp - inputs.upBestBid,
  };
  const down: SideEdge = {
    side: "down",
    tokenId: inputs.downTokenId,
    bid: inputs.downBestBid,
    ourProbability: ourProbDown,
    edge: inputs.downBestBid === null ? null : ourProbDown - inputs.downBestBid,
  };

  if (up.edge === null && down.edge === null) {
    return {
      kind: "skip",
      reason: "no-bid",
      snapshot,
      samples: lookup.samples,
      up,
      down,
    };
  }

  const chosen = pickHigherEdge({ up, down });
  const other = chosen === up ? down : up;
  if (chosen.edge === null || chosen.edge < inputs.minEdge) {
    return {
      kind: "skip",
      reason: "thin-edge",
      snapshot,
      samples: lookup.samples,
      up,
      down,
    };
  }

  return {
    kind: "trade",
    snapshot,
    samples: lookup.samples,
    chosen,
    other,
  };
}

function pickHigherEdge({
  up,
  down,
}: {
  readonly up: SideEdge;
  readonly down: SideEdge;
}): SideEdge {
  // `null`-edge sides represent "no resting bid" — they can't beat any
  // numeric edge by definition. Use −∞ as a sentinel so the comparison
  // collapses to "the side with a real bid."
  const upScore = up.edge ?? Number.NEGATIVE_INFINITY;
  const downScore = down.edge ?? Number.NEGATIVE_INFINITY;
  return upScore >= downScore ? up : down;
}
