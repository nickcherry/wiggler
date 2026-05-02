import type { CliValueOptionDefinition } from "@wiggler/lib/cli/types";
import type { ZodTypeAny } from "zod";

/**
 * Declares a `--key value` style option. The schema controls coercion and
 * whether the option is required.
 */
export function defineValueOption<
  const TKey extends string,
  TSchema extends ZodTypeAny,
>(
  option: Omit<CliValueOptionDefinition<TKey, TSchema>, "kind">,
): CliValueOptionDefinition<TKey, TSchema> {
  return { ...option, kind: "value" };
}
