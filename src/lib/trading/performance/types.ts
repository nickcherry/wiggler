export type TradingPerformanceSource = {
  readonly trades: string;
  readonly markets: string;
  readonly fees: string;
};

export type TradingPerformanceSummary = {
  readonly walletAddress: string;
  readonly tradeCount: number;
  readonly resolvedTradeCount: number;
  readonly unresolvedTradeCount: number;
  readonly resolvedMarketCount: number;
  readonly unresolvedMarketCount: number;
  readonly winningTradeCount: number;
  readonly losingTradeCount: number;
  readonly flatTradeCount: number;
  readonly lifetimePnlUsd: number;
  readonly resolvedFeesUsd: number;
  readonly totalFeesUsd: number;
  readonly totalVolumeUsd: number;
  readonly firstTradeAtMs: number | null;
  readonly lastTradeAtMs: number | null;
};

export type TradingPerformanceChartPoint = {
  readonly conditionId: string;
  readonly symbol: string;
  readonly question: string;
  readonly settledAtMs: number;
  readonly marketPnlUsd: number;
  readonly cumulativePnlUsd: number;
};

export type TradingPerformanceMarketRow = {
  readonly conditionId: string;
  readonly symbol: string;
  readonly question: string;
  readonly marketSlug: string | null;
  readonly endDateMs: number | null;
  readonly settledAtMs: number | null;
  readonly resolved: boolean;
  readonly winningOutcome: string | null;
  readonly tradeCount: number;
  readonly volumeUsd: number;
  readonly feesUsd: number;
  readonly pnlUsd: number | null;
};

export type TradingPerformanceTradeResult = "win" | "loss" | "flat" | "open";

export type TradingPerformanceTradeRow = {
  readonly id: string;
  readonly conditionId: string;
  readonly tokenId: string;
  readonly symbol: string;
  readonly question: string;
  readonly marketSlug: string | null;
  readonly side: "BUY" | "SELL";
  readonly traderSide: "MAKER" | "TAKER" | "UNKNOWN";
  readonly outcome: string;
  readonly size: number;
  readonly price: number;
  readonly notionalUsd: number;
  readonly feeRateBps: number;
  readonly feeUsd: number;
  readonly tradeTimeMs: number;
  readonly resolved: boolean;
  readonly resolvedPrice: number | null;
  readonly pnlUsd: number | null;
  readonly result: TradingPerformanceTradeResult;
  readonly transactionHash: string | null;
};

export type TradingPerformancePayload = {
  readonly command: "trading:performance";
  readonly generatedAtMs: number;
  readonly walletAddress: string;
  readonly source: TradingPerformanceSource;
  readonly summary: TradingPerformanceSummary;
  readonly chart: readonly TradingPerformanceChartPoint[];
  readonly markets: readonly TradingPerformanceMarketRow[];
  readonly trades: readonly TradingPerformanceTradeRow[];
};
