/**
 * Pure summation of lifetime PnL from a list of trades and the
 * resolution outcome of each market they touched. The trade-fetching
 * and market-resolution code both round-trip through I/O — this
 * module isolates the math so it stays unit-testable without
 * mocking the network.
 */

export type ScanTrade = {
  /** ConditionId of the market the trade hit. */
  readonly conditionId: string;
  /** Outcome token id within that market (one of two for up/down). */
  readonly tokenId: string;
  readonly side: "BUY" | "SELL";
  readonly size: number;
  readonly price: number;
  /** Per-fill fee amount normalized by the vendor boundary. */
  readonly feeUsd: number;
};

export type ScanMarketResolution = {
  readonly conditionId: string;
  readonly resolved: boolean;
  /**
   * For each token id, the resolution price (`1` for winner, `0` for
   * loser) when `resolved === true`. Empty for unresolved markets.
   */
  readonly outcomePriceByTokenId: ReadonlyMap<string, number>;
};

export type LifetimePnlBreakdown = {
  readonly lifetimePnlUsd: number;
  readonly resolvedMarketsCounted: number;
  readonly unresolvedMarketsSkipped: number;
  readonly tradesCounted: number;
};

/**
 * Computes lifetime PnL by summing realized cash flow plus settlement
 * payout per market. The formula handles both BUY and SELL fills and
 * both maker/taker fees:
 *
 *   For each (conditionId, tokenId) pair:
 *     shares     = Σ buy.size − Σ sell.size
 *     cashFlow   = − Σ buy.size × buy.price + Σ sell.size × sell.price
 *     fees       = Σ feeUsd
 *     payout     = shares × outcomePrice[tokenId]            (only if resolved)
 *     marketPnl  = cashFlow + payout − fees
 *
 * Markets that haven't resolved yet are skipped — their cash flow
 * contributes only when the resolution lands. This matches the
 * "wallet's USDC balance is the on-chain source of truth" framing
 * the doc commits to: realized PnL is only counted post-settlement.
 *
 * Trades for markets the resolver doesn't know about (e.g. extremely
 * old markets the venue dropped from `getMarket`) are skipped with a
 * warning at the call site, not silently lost.
 */
export function computeLifetimePnl({
  trades,
  resolutions,
}: {
  readonly trades: readonly ScanTrade[];
  readonly resolutions: readonly ScanMarketResolution[];
}): LifetimePnlBreakdown {
  const resolutionByConditionId = new Map(
    resolutions.map((r) => [r.conditionId, r] as const),
  );
  const tradesByMarket = new Map<string, ScanTrade[]>();
  for (const trade of trades) {
    const list = tradesByMarket.get(trade.conditionId);
    if (list === undefined) {
      tradesByMarket.set(trade.conditionId, [trade]);
    } else {
      list.push(trade);
    }
  }

  let lifetimePnl = 0;
  let resolvedMarketsCounted = 0;
  let unresolvedMarketsSkipped = 0;
  let tradesCounted = 0;
  for (const [conditionId, marketTrades] of tradesByMarket) {
    const resolution = resolutionByConditionId.get(conditionId);
    if (resolution === undefined || !resolution.resolved) {
      unresolvedMarketsSkipped += 1;
      continue;
    }
    resolvedMarketsCounted += 1;
    tradesCounted += marketTrades.length;

    // Sum per (tokenId) so SELLs and BUYs of opposite outcomes don't
    // entangle into one signed inventory.
    const tokenAgg = new Map<
      string,
      { shares: number; cashFlow: number; fees: number }
    >();
    for (const trade of marketTrades) {
      const agg = tokenAgg.get(trade.tokenId) ?? {
        shares: 0,
        cashFlow: 0,
        fees: 0,
      };
      const cost = trade.size * trade.price;
      if (trade.side === "BUY") {
        agg.shares += trade.size;
        agg.cashFlow -= cost;
      } else {
        agg.shares -= trade.size;
        agg.cashFlow += cost;
      }
      agg.fees += trade.feeUsd;
      tokenAgg.set(trade.tokenId, agg);
    }

    for (const [tokenId, agg] of tokenAgg) {
      const outcomePrice = resolution.outcomePriceByTokenId.get(tokenId) ?? 0;
      const payout = agg.shares * outcomePrice;
      lifetimePnl += agg.cashFlow + payout - agg.fees;
    }
  }

  return {
    lifetimePnlUsd: lifetimePnl,
    resolvedMarketsCounted,
    unresolvedMarketsSkipped,
    tradesCounted,
  };
}
