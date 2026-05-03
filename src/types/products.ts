import { productValues } from "@wiggler/constants/products";
import { z } from "zod";

/**
 * Boundary schema for the product column persisted on each candle row.
 */
export const productSchema = z.enum(productValues);

export type Product = z.infer<typeof productSchema>;
