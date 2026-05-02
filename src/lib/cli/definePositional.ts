import type { CliPositionalDefinition } from "@wiggler/lib/cli/types";
import type { ZodTypeAny } from "zod";

/**
 * Declares a positional argument. Schemas should use `.optional()` for
 * positionals that may be omitted.
 */
export function definePositional<
  const TKey extends string,
  TSchema extends ZodTypeAny,
>(
  positional: CliPositionalDefinition<TKey, TSchema>,
): CliPositionalDefinition<TKey, TSchema> {
  return positional;
}
