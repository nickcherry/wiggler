import type { LeadingSide } from "@alea/lib/trading/types";
import type { Asset } from "@alea/types/assets";

export type DryRunReportPayload = {
  readonly generatedAtMs: number;
  readonly sourcePath: string;
  readonly sessionStartAtMs: number | null;
  readonly sessionStopAtMs: number | null;
  readonly config: DryRunReportConfig | null;
  readonly summary: DryRunReportSummary;
  readonly byAsset: readonly DryRunAssetSummary[];
  readonly windows: readonly DryRunWindowSummary[];
  readonly orders: readonly DryRunReportOrder[];
  readonly parseErrors: readonly string[];
};

export type DryRunReportConfig = {
  readonly vendor: string | null;
  readonly priceSource: string | null;
  readonly assets: readonly Asset[];
  readonly minEdge: number | null;
  readonly stakeUsd: number | null;
  readonly tableRange: string | null;
  readonly telegramAlerts: boolean | null;
};

export type DryRunReportSummary = {
  readonly orderCount: number;
  readonly finalizedOrderCount: number;
  readonly pendingOrderCount: number;
  readonly canonicalFilledCount: number;
  readonly touchFilledCount: number;
  readonly canonicalFillRate: number | null;
  readonly touchFillRate: number | null;
  readonly filledWinRate: number | null;
  readonly allOrdersWinRate: number | null;
  readonly unfilledWouldWinRate: number | null;
  readonly canonicalPnlUsd: number;
  readonly touchPnlUsd: number;
  readonly allOrdersFilledPnlUsd: number;
  readonly unfilledCounterfactualPnlUsd: number;
  readonly fillSelectionDeltaUsd: number;
  readonly meanFillLatencyMs: number | null;
  readonly medianFillLatencyMs: number | null;
  readonly p90FillLatencyMs: number | null;
  readonly officialProxyDisagreementCount: number;
  readonly unfilledWouldWinCount: number;
  readonly unfilledWouldLoseCount: number;
  readonly filledWinCount: number;
  readonly filledLoseCount: number;
};

export type DryRunAssetSummary = DryRunReportSummary & {
  readonly asset: Asset;
};

export type DryRunWindowSummary = {
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly status: "pending" | "finalized";
  readonly orderCount: number;
  readonly canonicalFilledCount: number;
  readonly canonicalPnlUsd: number;
  readonly touchPnlUsd: number;
  readonly allOrdersFilledPnlUsd: number;
  readonly unfilledCounterfactualPnlUsd: number;
  readonly officialProxyDisagreementCount: number;
};

export type DryRunReportOrder = {
  readonly id: string;
  readonly asset: Asset;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly side: LeadingSide;
  readonly limitPrice: number;
  readonly sharesIfFilled: number;
  readonly placedAtMs: number;
  readonly expiresAtMs: number;
  readonly queueAheadShares: number | null;
  readonly observedAtLimitShares: number;
  readonly canonicalFilledShares: number;
  readonly canonicalFirstFillAtMs: number | null;
  readonly canonicalFullFillAtMs: number | null;
  readonly touchFilledAtMs: number | null;
  readonly entryPrice: number | null;
  readonly line: number | null;
  readonly upBestBid: number | null;
  readonly upBestAsk: number | null;
  readonly downBestBid: number | null;
  readonly downBestAsk: number | null;
  readonly spread: number | null;
  readonly remaining: number | null;
  readonly distanceBp: number | null;
  readonly samples: number | null;
  readonly modelProbability: number | null;
  readonly edge: number | null;
  readonly officialOutcome: LeadingSide | null;
  readonly proxyOutcome: LeadingSide | null;
  readonly officialResolvedAtMs: number | null;
  readonly officialPendingReason: string | null;
  readonly canonicalPnlUsd: number | null;
  readonly touchPnlUsd: number | null;
  readonly allOrdersFilledPnlUsd: number | null;
  readonly unfilledCounterfactualPnlUsd: number | null;
  readonly canonicalFillLatencyMs: number | null;
  readonly touchFillLatencyMs: number | null;
  readonly status: "pending" | "filled" | "partial" | "unfilled";
  readonly wonIfFilled: boolean | null;
  readonly officialProxyDisagreed: boolean;
};
