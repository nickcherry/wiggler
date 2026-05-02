import type { CliFlagOptionDefinition } from "@wiggler/lib/cli/types";
import type { ZodTypeAny } from "zod";

/**
 * Declares a boolean `--flag` style option. The schema is responsible for
 * defaulting to `false` when the flag is absent.
 */
export function defineFlagOption<
  const TKey extends string,
  TSchema extends ZodTypeAny,
>(
  option: Omit<CliFlagOptionDefinition<TKey, TSchema>, "kind">,
): CliFlagOptionDefinition<TKey, TSchema> {
  return { ...option, kind: "flag" };
}
