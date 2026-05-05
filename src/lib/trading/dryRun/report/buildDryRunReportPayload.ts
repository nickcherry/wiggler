import { computeDryPnlUsd } from "@alea/lib/trading/dryRun/metrics";
import type {
  DryRunAssetSummary,
  DryRunReportConfig,
  DryRunReportOrder,
  DryRunReportPayload,
  DryRunReportSummary,
  DryRunWindowSummary,
} from "@alea/lib/trading/dryRun/report/types";
import type { LeadingSide } from "@alea/lib/trading/types";
import { type Asset, assetSchema } from "@alea/types/assets";

export function buildDryRunReportPayload({
  records,
  sourcePath,
  generatedAtMs = Date.now(),
}: {
  readonly records: readonly unknown[];
  readonly sourcePath: string;
  readonly generatedAtMs?: number;
}): DryRunReportPayload {
  let sessionStartAtMs: number | null = null;
  let sessionStopAtMs: number | null = null;
  let config: DryRunReportConfig | null = null;
  const parseErrors: string[] = [];
  const ordersById = new Map<string, DryRunReportOrder>();
  const windowsByStart = new Map<number, DryRunWindowSummary>();

  for (const [index, recordUnknown] of records.entries()) {
    const record = asRecord(recordUnknown);
    if (record === null) {
      parseErrors.push(`line ${index + 1}: record is not an object`);
      continue;
    }
    const type = stringField({ object: record, key: "type" });
    if (type === "session_start") {
      sessionStartAtMs = numberField({ object: record, key: "atMs" });
      config = parseConfig({ value: record["config"] });
      continue;
    }
    if (type === "session_stop") {
      sessionStopAtMs = numberField({ object: record, key: "atMs" });
      continue;
    }
    if (type === "virtual_order") {
      const order = parseOrder({ value: record["order"] });
      if (order === null) {
        parseErrors.push(
          `line ${index + 1}: virtual_order has no usable order`,
        );
      } else {
        ordersById.set(order.id, order);
      }
      continue;
    }
    if (type === "window_checkpoint" || type === "window_finalized") {
      const windowStartMs = numberField({
        object: record,
        key: "windowStartMs",
      });
      const windowEndMs = numberField({ object: record, key: "windowEndMs" });
      const orders = arrayField({ object: record, key: "orders" })
        .map((value) => parseOrder({ value }))
        .filter((order): order is DryRunReportOrder => order !== null);
      for (const order of orders) {
        ordersById.set(order.id, order);
      }
      if (windowStartMs !== null && windowEndMs !== null) {
        const orderList =
          orders.length > 0
            ? orders
            : ordersForWindow({
                orders: [...ordersById.values()],
                windowStartMs,
              });
        windowsByStart.set(
          windowStartMs,
          buildWindowSummary({
            windowStartMs,
            windowEndMs,
            status: type === "window_finalized" ? "finalized" : "pending",
            orders: orderList,
          }),
        );
      }
    }
  }

  const orders = [...ordersById.values()].sort(
    (a, b) => a.placedAtMs - b.placedAtMs,
  );
  const summary = summarizeOrders({ orders });
  const byAsset = summarizeByAsset({ orders, config });
  const windows = [...windowsByStart.values()].sort(
    (a, b) => a.windowStartMs - b.windowStartMs,
  );

  return {
    generatedAtMs,
    sourcePath,
    sessionStartAtMs,
    sessionStopAtMs,
    config,
    summary,
    byAsset,
    windows,
    orders,
    parseErrors,
  };
}

function parseConfig({
  value,
}: {
  readonly value: unknown;
}): DryRunReportConfig | null {
  const object = asRecord(value);
  if (object === null) {
    return null;
  }
  const assets = arrayField({ object, key: "assets" })
    .map((entry) => assetSchema.safeParse(entry))
    .filter((entry) => entry.success)
    .map((entry) => entry.data);
  return {
    vendor: stringField({ object, key: "vendor" }),
    priceSource: stringField({ object, key: "priceSource" }),
    assets,
    minEdge: numberField({ object, key: "minEdge" }),
    stakeUsd: numberField({ object, key: "stakeUsd" }),
    tableRange: stringField({ object, key: "tableRange" }),
    telegramAlerts: booleanField({ object, key: "telegramAlerts" }),
  };
}

function parseOrder({
  value,
}: {
  readonly value: unknown;
}): DryRunReportOrder | null {
  const object = asRecord(value);
  if (object === null) {
    return null;
  }
  const id = stringField({ object, key: "id" });
  const asset = assetSchema.safeParse(object["asset"]);
  const side = leadingSideField({ object, key: "side" });
  const windowStartMs = numberField({ object, key: "windowStartMs" });
  const windowEndMs = numberField({ object, key: "windowEndMs" });
  const limitPrice = numberField({ object, key: "limitPrice" });
  const sharesIfFilled = numberField({ object, key: "sharesIfFilled" });
  const placedAtMs = numberField({ object, key: "placedAtMs" });
  const expiresAtMs = numberField({ object, key: "expiresAtMs" });
  if (
    id === null ||
    !asset.success ||
    side === null ||
    windowStartMs === null ||
    windowEndMs === null ||
    limitPrice === null ||
    sharesIfFilled === null ||
    placedAtMs === null ||
    expiresAtMs === null
  ) {
    return null;
  }
  const officialOutcome = leadingSideNullable({
    value: object["officialOutcome"],
  });
  const proxyOutcome = proxyOutcomeField({ object });
  const canonicalFilledShares =
    numberField({ object, key: "canonicalFilledShares" }) ?? 0;
  const canonicalFirstFillAtMs = numberField({
    object,
    key: "canonicalFirstFillAtMs",
  });
  const touchFilledAtMs = numberField({ object, key: "touchFilledAtMs" });
  const wonIfFilled =
    officialOutcome === null ? null : side === officialOutcome;
  const canonicalPnlUsd =
    officialOutcome === null || canonicalFilledShares <= 0
      ? null
      : computeDryPnlUsd({
          shares: canonicalFilledShares,
          price: limitPrice,
          won: side === officialOutcome,
        });
  const touchPnlUsd =
    officialOutcome === null || touchFilledAtMs === null
      ? null
      : computeDryPnlUsd({
          shares: sharesIfFilled,
          price: limitPrice,
          won: side === officialOutcome,
        });
  const allOrdersFilledPnlUsd =
    officialOutcome === null
      ? null
      : computeDryPnlUsd({
          shares: sharesIfFilled,
          price: limitPrice,
          won: side === officialOutcome,
        });
  const unfilledCounterfactualPnlUsd =
    canonicalFilledShares > 0 ? null : allOrdersFilledPnlUsd;

  return {
    id,
    asset: asset.data,
    windowStartMs,
    windowEndMs,
    side,
    limitPrice,
    sharesIfFilled,
    placedAtMs,
    expiresAtMs,
    queueAheadShares: numberField({ object, key: "queueAheadShares" }),
    observedAtLimitShares:
      numberField({ object, key: "observedAtLimitShares" }) ?? 0,
    canonicalFilledShares,
    canonicalFirstFillAtMs,
    canonicalFullFillAtMs: numberField({
      object,
      key: "canonicalFullFillAtMs",
    }),
    touchFilledAtMs,
    entryPrice: numberField({ object, key: "entryPrice" }),
    line: numberField({ object, key: "line" }),
    upBestBid: numberField({ object, key: "upBestBid" }),
    upBestAsk: numberField({ object, key: "upBestAsk" }),
    downBestBid: numberField({ object, key: "downBestBid" }),
    downBestAsk: numberField({ object, key: "downBestAsk" }),
    spread: numberField({ object, key: "spread" }),
    remaining: numberField({ object, key: "remaining" }),
    distanceBp: numberField({ object, key: "distanceBp" }),
    samples: numberField({ object, key: "samples" }),
    modelProbability: numberField({ object, key: "modelProbability" }),
    edge: numberField({ object, key: "edge" }),
    officialOutcome,
    proxyOutcome,
    officialResolvedAtMs: numberField({ object, key: "officialResolvedAtMs" }),
    officialPendingReason: stringField({
      object,
      key: "officialPendingReason",
    }),
    canonicalPnlUsd,
    touchPnlUsd,
    allOrdersFilledPnlUsd,
    unfilledCounterfactualPnlUsd,
    canonicalFillLatencyMs:
      canonicalFirstFillAtMs === null
        ? null
        : canonicalFirstFillAtMs - placedAtMs,
    touchFillLatencyMs:
      touchFilledAtMs === null ? null : touchFilledAtMs - placedAtMs,
    status: statusForOrder({
      canonicalFilledShares,
      sharesIfFilled,
      officialOutcome,
    }),
    wonIfFilled,
    officialProxyDisagreed:
      officialOutcome !== null &&
      proxyOutcome !== null &&
      officialOutcome !== proxyOutcome,
  };
}

function summarizeByAsset({
  orders,
  config,
}: {
  readonly orders: readonly DryRunReportOrder[];
  readonly config: DryRunReportConfig | null;
}): DryRunAssetSummary[] {
  const configuredAssets = config?.assets ?? [];
  const assets = new Set<Asset>(configuredAssets);
  for (const order of orders) {
    assets.add(order.asset);
  }
  return [...assets].sort().map((asset) => ({
    asset,
    ...summarizeOrders({
      orders: orders.filter((order) => order.asset === asset),
    }),
  }));
}

function summarizeOrders({
  orders,
}: {
  readonly orders: readonly DryRunReportOrder[];
}): DryRunReportSummary {
  const finalized = orders.filter((order) => order.officialOutcome !== null);
  const canonicalFilled = finalized.filter(
    (order) => order.canonicalFilledShares > 0,
  );
  const touchFilled = finalized.filter(
    (order) => order.touchFilledAtMs !== null,
  );
  const unfilled = finalized.filter(
    (order) => order.canonicalFilledShares <= 0,
  );
  const filledWins = canonicalFilled.filter((order) => order.wonIfFilled);
  const allWins = finalized.filter((order) => order.wonIfFilled);
  const unfilledWins = unfilled.filter((order) => order.wonIfFilled);
  const latencies = canonicalFilled
    .map((order) => order.canonicalFillLatencyMs)
    .filter((value): value is number => value !== null);
  const canonicalPnlUsd = sum(finalized.map((order) => order.canonicalPnlUsd));
  const allOrdersFilledPnlUsd = sum(
    finalized.map((order) => order.allOrdersFilledPnlUsd),
  );
  return {
    orderCount: orders.length,
    finalizedOrderCount: finalized.length,
    pendingOrderCount: orders.length - finalized.length,
    canonicalFilledCount: canonicalFilled.length,
    touchFilledCount: touchFilled.length,
    canonicalFillRate:
      finalized.length === 0 ? null : canonicalFilled.length / finalized.length,
    touchFillRate:
      finalized.length === 0 ? null : touchFilled.length / finalized.length,
    filledWinRate:
      canonicalFilled.length === 0
        ? null
        : filledWins.length / canonicalFilled.length,
    allOrdersWinRate:
      finalized.length === 0 ? null : allWins.length / finalized.length,
    unfilledWouldWinRate:
      unfilled.length === 0 ? null : unfilledWins.length / unfilled.length,
    canonicalPnlUsd,
    touchPnlUsd: sum(finalized.map((order) => order.touchPnlUsd)),
    allOrdersFilledPnlUsd,
    unfilledCounterfactualPnlUsd: sum(
      finalized.map((order) => order.unfilledCounterfactualPnlUsd),
    ),
    fillSelectionDeltaUsd: canonicalPnlUsd - allOrdersFilledPnlUsd,
    meanFillLatencyMs: mean(latencies),
    medianFillLatencyMs: percentile({ values: latencies, p: 0.5 }),
    p90FillLatencyMs: percentile({ values: latencies, p: 0.9 }),
    officialProxyDisagreementCount: finalized.filter(
      (order) => order.officialProxyDisagreed,
    ).length,
    unfilledWouldWinCount: unfilledWins.length,
    unfilledWouldLoseCount: unfilled.length - unfilledWins.length,
    filledWinCount: filledWins.length,
    filledLoseCount: canonicalFilled.length - filledWins.length,
  };
}

function buildWindowSummary({
  windowStartMs,
  windowEndMs,
  status,
  orders,
}: {
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly status: "pending" | "finalized";
  readonly orders: readonly DryRunReportOrder[];
}): DryRunWindowSummary {
  const summary = summarizeOrders({ orders });
  return {
    windowStartMs,
    windowEndMs,
    status,
    orderCount: orders.length,
    canonicalFilledCount: summary.canonicalFilledCount,
    canonicalPnlUsd: summary.canonicalPnlUsd,
    touchPnlUsd: summary.touchPnlUsd,
    allOrdersFilledPnlUsd: summary.allOrdersFilledPnlUsd,
    unfilledCounterfactualPnlUsd: summary.unfilledCounterfactualPnlUsd,
    officialProxyDisagreementCount: summary.officialProxyDisagreementCount,
  };
}

function ordersForWindow({
  orders,
  windowStartMs,
}: {
  readonly orders: readonly DryRunReportOrder[];
  readonly windowStartMs: number;
}): DryRunReportOrder[] {
  return orders.filter((order) => order.windowStartMs === windowStartMs);
}

function statusForOrder({
  canonicalFilledShares,
  sharesIfFilled,
  officialOutcome,
}: {
  readonly canonicalFilledShares: number;
  readonly sharesIfFilled: number;
  readonly officialOutcome: LeadingSide | null;
}): DryRunReportOrder["status"] {
  if (officialOutcome === null) {
    return "pending";
  }
  if (canonicalFilledShares <= 0) {
    return "unfilled";
  }
  if (canonicalFilledShares + 1e-9 < sharesIfFilled) {
    return "partial";
  }
  return "filled";
}

function proxyOutcomeField({
  object,
}: {
  readonly object: Record<string, unknown>;
}): LeadingSide | null {
  const proxy = asRecord(object["proxyOutcome"]);
  if (proxy === null) {
    return null;
  }
  return leadingSideNullable({ value: proxy["winningSide"] });
}

function leadingSideField({
  object,
  key,
}: {
  readonly object: Record<string, unknown>;
  readonly key: string;
}): LeadingSide | null {
  return leadingSideNullable({ value: object[key] });
}

function leadingSideNullable({
  value,
}: {
  readonly value: unknown;
}): LeadingSide | null {
  return value === "up" || value === "down" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField({
  object,
  key,
}: {
  readonly object: Record<string, unknown>;
  readonly key: string;
}): string | null {
  const value = object[key];
  return typeof value === "string" ? value : null;
}

function numberField({
  object,
  key,
}: {
  readonly object: Record<string, unknown>;
  readonly key: string;
}): number | null {
  const value = object[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanField({
  object,
  key,
}: {
  readonly object: Record<string, unknown>;
  readonly key: string;
}): boolean | null {
  const value = object[key];
  return typeof value === "boolean" ? value : null;
}

function arrayField({
  object,
  key,
}: {
  readonly object: Record<string, unknown>;
  readonly key: string;
}): unknown[] {
  const value = object[key];
  return Array.isArray(value) ? value : [];
}

function sum(values: readonly (number | null)[]): number {
  return values.reduce<number>((acc, value) => acc + (value ?? 0), 0);
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function percentile({
  values,
  p,
}: {
  readonly values: readonly number[];
  readonly p: number;
}): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[index] ?? null;
}
