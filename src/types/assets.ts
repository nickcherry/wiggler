import { assetValues } from "@wiggler/constants/assets";
import { z } from "zod";

/**
 * Boundary schema for asset codes. Lower-case canonical form.
 */
export const assetSchema = z.enum(assetValues);

export type Asset = z.infer<typeof assetSchema>;
