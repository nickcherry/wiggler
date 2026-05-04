import { MIN_ACTIONABLE_DISTANCE_BP } from "@alea/constants/trading";
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
   * CLOSED 5m bar. Retained for diagnostic logging on the
   * `DecisionSnapshot`; **no longer the conditioning variable for
   * the probability lookup** since we promoted to the live
   * distance-from-line ATR filter (see `atr` below). `null` until
   * ≥50 closed bars have been seen.
   */
  readonly ema50: number | null;
  /**
   * Most recent Wilder ATR evaluated *through and including* the last
   * CLOSED 5m bar at the `LIVE_TRADING_ATR_PERIOD` period. Used to
   * compute the `decisivelyAway` classification:
   * `decisivelyAway = |currentPrice − line| ≥ 0.5 × ATR`. Matches the
   * training-side live filter exactly. `null` until the tracker has
   * seeded — the runner skips with `warmup` until then.
   */
  readonly atr: number | null;
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
 *   2. ATR-14 not seeded → skip (`warmup`). The active probability
 *      surface is conditioned on distance from the line in ATR terms.
 *   3. Compute current side, bp distance, and the active filter's
 *      `aligned` flag (`|price - line| >= 0.5 * ATR-14`); look up the
 *      probability table bucket. Missing bucket (outside the sweet
 *      spot, too thin, or very-far-from-line tail) → skip (`no-bucket`).
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
  if (inputs.atr === null || inputs.atr <= 0) {
    return {
      kind: "skip",
      reason: "warmup",
      snapshot: null,
      samples: null,
      up: null,
      down: null,
    };
  }

  const distanceAbs = Math.abs(inputs.currentPrice - inputs.line);
  const distanceBp = Math.floor((distanceAbs / inputs.line) * 10_000 + 1e-9);
  if (distanceBp < MIN_ACTIONABLE_DISTANCE_BP) {
    return {
      kind: "skip",
      reason: "too-close-to-line",
      snapshot: null,
      samples: null,
      up: null,
      down: null,
    };
  }
  const currentSide: LeadingSide =
    inputs.currentPrice >= inputs.line ? "up" : "down";
  // EMA-50 regime kept for diagnostic logging only; the decision
  // doesn't condition on it anymore. We compute when EMA is available.
  const regime: LeadingSide | null =
    inputs.ema50 === null ? null : inputs.line >= inputs.ema50 ? "up" : "down";
  // Filter classification: `decisivelyAway = |distance| >= 0.5 × ATR`.
  // Mirrors the live filter (`LIVE_TRADING_FILTER.classify`) in the
  // training pipeline. `aligned` is named for back-compat with the
  // existing probability-table surface naming (true → "decisively
  // away" surface, false → "near the line" surface); rename to
  // `decisivelyAway` is a separate, mechanical pass.
  const aligned = distanceAbs >= 0.5 * inputs.atr;

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
