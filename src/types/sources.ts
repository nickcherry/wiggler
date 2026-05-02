import { candleSourceValues } from "@wiggler/constants/sources";
import { z } from "zod";

/**
 * Boundary schema for the candle source identifier persisted on each row.
 */
export const candleSourceSchema = z.enum(candleSourceValues);

export type CandleSource = z.infer<typeof candleSourceSchema>;
