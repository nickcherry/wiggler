import { exchangeIdValues } from "@alea/constants/exchanges";
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

/**
 * Persisted shape of one `latency:capture` run. Matches
 * `CaptureAllQuoteStreamsResult` so a saved JSON file can be parsed back
 * with the same Zod boundary.
 */
export const quoteCaptureSchema = z.object({
  startedAtMs: z.number(),
  endedAtMs: z.number(),
  durationMs: z.number(),
  ticks: z.array(quoteTickSchema),
  tickCounts: z.partialRecord(exchangeIdSchema, z.number().int().nonnegative()),
  errors: z.array(z.object({ exchange: exchangeIdSchema, error: z.string() })),
  // Records whether the capture was run in `--exhaustive` mode. When true,
  // the chart renders extra emphasis (faded venues, bold polymarket, VWAP
  // overlays); when false, every series renders with uniform styling.
  // Optional for backward compatibility with older captures.
  exhaustive: z.boolean().optional(),
});

export type QuoteCapture = z.infer<typeof quoteCaptureSchema>;
