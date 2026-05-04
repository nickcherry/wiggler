import type { DirectionalOutcome } from "@alea/lib/reliability/types";

/**
 * Polymarket's current 5m crypto rule and the existing trading code both
 * treat equality as an Up win.
 */
export function resolveDirectionalOutcome({
  startPrice,
  endPrice,
}: {
  readonly startPrice: number;
  readonly endPrice: number;
}): DirectionalOutcome {
  return endPrice >= startPrice ? "up" : "down";
}
