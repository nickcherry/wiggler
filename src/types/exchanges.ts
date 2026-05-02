import { exchangeIdValues } from "@wiggler/constants/exchanges";
import { z } from "zod";

/**
 * Boundary schema for the exchange identifiers used on every captured tick.
 */
export const exchangeIdSchema = z.enum(exchangeIdValues);

export type ExchangeId = z.infer<typeof exchangeIdSchema>;

/**
 * One BBO observation from one exchange. `mid` is the simple `(bid + ask) / 2`
 * and is what the price-line chart plots.
 */
export const quoteTickSchema = z.object({
  exchange: exchangeIdSchema,
  tsReceivedMs: z.number(),
  tsExchangeMs: z.number().nullable(),
  bid: z.number().finite().positive(),
  ask: z.number().finite().positive(),
  mid: z.number().finite().positive(),
});

export type QuoteTick = z.infer<typeof quoteTickSchema>;
