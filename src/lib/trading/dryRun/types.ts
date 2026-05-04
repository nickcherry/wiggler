import type { TradeDecision } from "@alea/lib/trading/decision/types";
import type { SimulatedDryOrder } from "@alea/lib/trading/dryRun/fillSimulation";
import type { DryAggregateMetrics } from "@alea/lib/trading/dryRun/metrics";
import type { Asset } from "@alea/types/assets";

/**
 * One log row emitted by the dry-run runner. The CLI formats these
 * for human consumption; structured tests / replays consume the same
 * shape directly.
 */
export type DryRunEvent =
  | {
      readonly kind: "info";
      readonly atMs: number;
      readonly message: string;
    }
  | {
      readonly kind: "warn";
      readonly atMs: number;
      readonly message: string;
    }
  | {
      readonly kind: "error";
      readonly atMs: number;
      readonly message: string;
    }
  | {
      readonly kind: "decision";
      readonly atMs: number;
      readonly decision: TradeDecision;
    }
  | {
      readonly kind: "virtual-order";
      readonly atMs: number;
      readonly asset: Asset;
      readonly order: SimulatedDryOrder;
    }
  | {
      readonly kind: "virtual-fill";
      readonly atMs: number;
      readonly asset: Asset;
      readonly order: SimulatedDryOrder;
    }
  | {
      readonly kind: "window-finalized";
      readonly atMs: number;
      readonly windowStartMs: number;
      readonly windowEndMs: number;
      readonly metrics: DryAggregateMetrics;
    };
