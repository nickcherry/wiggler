import type { TradeDecision } from "@alea/lib/trading/decision/types";

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
    };
