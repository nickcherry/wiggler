import { candleTimeframeSchema } from "@alea/types/candles";
import { productSchema } from "@alea/types/products";
import { candleSourceSchema } from "@alea/types/sources";
import { z } from "zod";

/**
 * A `(source, product, timeframe)` tuple that uniquely identifies a kind of
 * candle stream — what venue it came from, whether it tracks the spot or the
 * perpetual market, and at what bar resolution. It does not include `asset`,
 * because the same stream definition applies across every asset we track.
 *
 * Used as a single typed handle wherever code needs to talk about "which
 * candles" without enumerating the three component fields every time.
 */
export const candleSeriesSchema = z.object({
  source: candleSourceSchema,
  product: productSchema,
  timeframe: candleTimeframeSchema,
});

export type CandleSeries = z.infer<typeof candleSeriesSchema>;
