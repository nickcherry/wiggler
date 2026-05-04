import { assetSchema } from "@alea/types/assets";
import type { ExchangeId } from "@alea/types/exchanges";
import { z } from "zod";

export const RELIABILITY_SCHEMA_VERSION = 1;

export const reliabilitySourceValues = [
  "polymarket-chainlink",
  "coinbase-spot",
  "coinbase-perp",
  "binance-spot",
  "binance-perp",
] as const satisfies readonly ExchangeId[];

export const comparableReliabilitySourceValues = [
  "coinbase-spot",
  "coinbase-perp",
  "binance-spot",
  "binance-perp",
] as const;

export const baselineReliabilitySource = "polymarket-chainlink" as const;

export const reliabilitySourceSchema = z.enum(reliabilitySourceValues);

export type ReliabilitySource = z.infer<typeof reliabilitySourceSchema>;

export const directionalOutcomeSchema = z.enum(["up", "down"]);
export type DirectionalOutcome = z.infer<typeof directionalOutcomeSchema>;

export const reliabilityCellStatusSchema = z.enum([
  "pending",
  "complete",
  "missing-start",
  "missing-end",
  "stale-start",
  "stale-end",
  "no-market",
]);

export type ReliabilityCellStatus = z.infer<typeof reliabilityCellStatusSchema>;

export const reliabilityMarketStatusSchema = z.enum([
  "pending",
  "active",
  "missing",
  "error",
]);

export const reliabilitySourceCellSchema = z.object({
  source: reliabilitySourceSchema,
  status: reliabilityCellStatusSchema,
  startPrice: z.number().finite().positive().nullable(),
  startAtMs: z.number().nullable(),
  startLagMs: z.number().nullable(),
  endPrice: z.number().finite().positive().nullable(),
  endAtMs: z.number().nullable(),
  endLagMs: z.number().nullable(),
  deltaBp: z.number().nullable(),
  outcome: directionalOutcomeSchema.nullable(),
  agreesWithPolymarket: z.boolean().nullable(),
});

export type ReliabilitySourceCell = z.infer<typeof reliabilitySourceCellSchema>;

export const reliabilityAssetWindowSchema = z.object({
  asset: assetSchema,
  status: z.enum(["active", "complete"]),
  windowStartMs: z.number(),
  windowEndMs: z.number(),
  marketSlug: z.string(),
  conditionId: z.string().nullable(),
  marketStatus: reliabilityMarketStatusSchema,
  marketError: z.string().nullable(),
  finalizedAtMs: z.number().nullable(),
  sources: z.record(reliabilitySourceSchema, reliabilitySourceCellSchema),
});

export type ReliabilityAssetWindow = z.infer<
  typeof reliabilityAssetWindowSchema
>;

export const reliabilitySourceHealthSchema = z.object({
  source: reliabilitySourceSchema,
  connected: z.boolean(),
  connectCount: z.number().int().nonnegative(),
  disconnectCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  ticks: z.number().int().nonnegative(),
  lastTickAtMs: z.number().nullable(),
  lastError: z.string().nullable(),
});

export type ReliabilitySourceHealth = z.infer<
  typeof reliabilitySourceHealthSchema
>;

export const reliabilitySourceSummarySchema = z.object({
  source: reliabilitySourceSchema,
  totalAssetWindows: z.number().int().nonnegative(),
  comparableWindows: z.number().int().nonnegative(),
  agreements: z.number().int().nonnegative(),
  disagreements: z.number().int().nonnegative(),
  unavailable: z.number().int().nonnegative(),
  agreementRate: z.number().nullable(),
  nearZeroComparable: z.number().int().nonnegative(),
  nearZeroDisagreements: z.number().int().nonnegative(),
});

export type ReliabilitySourceSummary = z.infer<
  typeof reliabilitySourceSummarySchema
>;

export const reliabilityAssetSourceSummarySchema =
  reliabilitySourceSummarySchema.extend({ asset: assetSchema });

export const reliabilitySummarySchema = z.object({
  completedAssetWindows: z.number().int().nonnegative(),
  baselineCompleteWindows: z.number().int().nonnegative(),
  nearZeroThresholdBp: z.number().int().nonnegative(),
  sources: z.array(reliabilitySourceSummarySchema),
  byAsset: z.array(reliabilityAssetSourceSummarySchema),
});

export type ReliabilitySummary = z.infer<typeof reliabilitySummarySchema>;

export const reliabilityErrorSchema = z.object({
  atMs: z.number(),
  source: reliabilitySourceSchema.nullable(),
  message: z.string(),
});

export const reliabilityCapturePayloadSchema = z.object({
  schemaVersion: z.literal(RELIABILITY_SCHEMA_VERSION),
  startedAtMs: z.number(),
  updatedAtMs: z.number(),
  requestedDurationMs: z.number().int().nonnegative(),
  captureStartWindowMs: z.number(),
  captureEndMs: z.number().nullable(),
  graceMs: z.number().int().nonnegative(),
  nearZeroThresholdBp: z.number().int().nonnegative(),
  assets: z.array(assetSchema),
  sources: z.array(reliabilitySourceSchema),
  baselineSource: z.literal(baselineReliabilitySource),
  activeWindows: z.array(reliabilityAssetWindowSchema),
  completedWindows: z.array(reliabilityAssetWindowSchema),
  sourceHealth: z.array(reliabilitySourceHealthSchema),
  errors: z.array(reliabilityErrorSchema),
  summary: reliabilitySummarySchema,
});

export type ReliabilityCapturePayload = z.infer<
  typeof reliabilityCapturePayloadSchema
>;

export type ReliabilityPriceTick = {
  readonly source: ReliabilitySource;
  readonly asset: z.infer<typeof assetSchema>;
  readonly price: number;
  readonly receivedAtMs: number;
  readonly exchangeTimeMs: number | null;
};

export type ReliabilityCaptureEvent =
  | { readonly kind: "info"; readonly atMs: number; readonly message: string }
  | { readonly kind: "warn"; readonly atMs: number; readonly message: string }
  | { readonly kind: "error"; readonly atMs: number; readonly message: string }
  | {
      readonly kind: "source-open";
      readonly atMs: number;
      readonly source: ReliabilitySource;
    }
  | {
      readonly kind: "source-close";
      readonly atMs: number;
      readonly source: ReliabilitySource;
      readonly reason: string;
    }
  | {
      readonly kind: "window-opened";
      readonly atMs: number;
      readonly windowStartMs: number;
      readonly assetCount: number;
    }
  | {
      readonly kind: "window-finalized";
      readonly atMs: number;
      readonly windowStartMs: number;
      readonly windows: readonly ReliabilityAssetWindow[];
    };
