import type { TradeDecision } from "@alea/lib/trading/decision/types";
import type { AssetSlot } from "@alea/lib/trading/state/types";
import type { Asset } from "@alea/types/assets";

/**
 * One log row emitted by the live runner. Mirrors the dry-run event
 * shape so callers can reuse the same formatter.
 */
export type LiveEvent =
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
      readonly kind: "order-placed";
      readonly atMs: number;
      readonly asset: Asset;
      readonly slot: Extract<AssetSlot, { kind: "active" }>;
    }
  | {
      readonly kind: "fill";
      readonly atMs: number;
      readonly asset: Asset;
      readonly slot: Extract<AssetSlot, { kind: "active" }>;
    }
  | {
      readonly kind: "window-summary";
      readonly atMs: number;
      readonly windowStartMs: number;
      readonly windowEndMs: number;
      readonly body: string;
    };
