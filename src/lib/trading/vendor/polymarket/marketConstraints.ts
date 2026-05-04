import type { MarketOrderConstraints } from "@alea/lib/trading/vendor/types";
import type { TickSize } from "@polymarket/clob-client-v2";
import { z } from "zod";

const ALLOWED_TICK_SIZES = ["0.1", "0.01", "0.001", "0.0001"] as const;

export type PolymarketOrderConstraints = MarketOrderConstraints & {
  readonly negRisk: boolean;
  readonly tickSize: TickSize;
  readonly rfqEnabled: boolean | null;
  readonly takerOrderDelayEnabled: boolean | null;
};

export const DEFAULT_POLYMARKET_ORDER_CONSTRAINTS: PolymarketOrderConstraints =
  {
    priceTickSize: 0.01,
    tickSize: "0.01",
    minOrderSize: 1,
    minimumOrderAgeSeconds: 0,
    makerBaseFeeBps: null,
    takerBaseFeeBps: null,
    feesTakerOnly: null,
    negRisk: false,
    rfqEnabled: null,
    takerOrderDelayEnabled: null,
  };

export function mergePolymarketOrderConstraints(
  ...items: readonly (Partial<PolymarketOrderConstraints> | null | undefined)[]
): PolymarketOrderConstraints {
  let out = DEFAULT_POLYMARKET_ORDER_CONSTRAINTS;
  for (const item of items) {
    if (item === null || item === undefined) {
      continue;
    }
    const tick =
      item.tickSize ??
      (item.priceTickSize === undefined
        ? undefined
        : tickSizeForNumber({ value: item.priceTickSize }));
    out = {
      ...out,
      ...item,
      tickSize: tick ?? out.tickSize,
      priceTickSize: tick === undefined ? out.priceTickSize : Number(tick),
      minOrderSize: Math.max(out.minOrderSize, item.minOrderSize ?? 0),
      minimumOrderAgeSeconds: Math.max(
        out.minimumOrderAgeSeconds,
        item.minimumOrderAgeSeconds ?? 0,
      ),
      negRisk: out.negRisk || item.negRisk === true,
    };
  }
  return out;
}

export function parseBookConstraints(input: {
  readonly raw: unknown;
}): Partial<PolymarketOrderConstraints> | null {
  const parsed = bookConstraintSchema.safeParse(input.raw);
  if (!parsed.success) {
    return null;
  }
  const tickSize = tickSizeForNumber({ value: Number(parsed.data.tick_size) });
  if (tickSize === null) {
    return null;
  }
  return {
    tickSize,
    priceTickSize: Number(parsed.data.tick_size),
    minOrderSize: Number(parsed.data.min_order_size),
    negRisk: parsed.data.neg_risk,
  };
}

export function parseClobMarketInfoConstraints(input: {
  readonly raw: unknown;
  readonly fallbackNegRisk?: boolean;
}): Partial<PolymarketOrderConstraints> | null {
  const parsed = clobMarketInfoSchema.safeParse(input.raw);
  if (!parsed.success) {
    return null;
  }
  const tickSize = tickSizeForNumber({ value: parsed.data.mts });
  if (tickSize === null) {
    return null;
  }
  return {
    tickSize,
    priceTickSize: Number(tickSize),
    minOrderSize: parsed.data.mos,
    minimumOrderAgeSeconds: parsed.data.oas ?? 0,
    makerBaseFeeBps: parsed.data.mbf ?? null,
    takerBaseFeeBps: parsed.data.tbf ?? null,
    feesTakerOnly: parsed.data.fd?.to ?? null,
    negRisk: parsed.data.nr ?? input.fallbackNegRisk ?? false,
    rfqEnabled: parsed.data.rfqe ?? null,
    takerOrderDelayEnabled: parsed.data.itode ?? null,
  };
}

export function tickSizeForNumber({
  value,
}: {
  readonly value: number;
}): TickSize | null {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  for (const candidate of ALLOWED_TICK_SIZES) {
    if (Math.abs(Number(candidate) - value) < 1e-12) {
      return candidate;
    }
  }
  return null;
}

const numericStringSchema = z
  .string()
  .refine((value) => Number.isFinite(Number(value)), "expected numeric string");

const bookConstraintSchema = z.object({
  min_order_size: numericStringSchema,
  tick_size: numericStringSchema,
  neg_risk: z.boolean(),
});

const clobMarketInfoSchema = z
  .object({
    mos: z.number().finite().positive().optional().default(1),
    mts: z.number().finite().positive(),
    mbf: z.number().finite().optional(),
    tbf: z.number().finite().optional(),
    nr: z.boolean().optional(),
    rfqe: z.boolean().optional(),
    itode: z.boolean().optional(),
    oas: z.number().finite().nonnegative().optional(),
    fd: z
      .object({
        r: z.number().finite().optional(),
        e: z.number().finite().optional(),
        to: z.boolean().optional(),
      })
      .optional(),
  })
  .passthrough();
