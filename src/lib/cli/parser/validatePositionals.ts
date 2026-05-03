import { validateInputValue } from "@alea/lib/cli/parser/validateInputValue";
import type {
  CliAnyCommandDefinition,
  CliPositionalDefinition,
} from "@alea/lib/cli/types";

/**
 * Validates and coerces all positional argument values for a parsed command.
 * Returns a plain object keyed by `positional.key`.
 */
export function validatePositionals({
  appName,
  command,
  positionals,
  rawPositionals,
}: {
  readonly appName: string;
  readonly command: CliAnyCommandDefinition;
  readonly positionals: readonly CliPositionalDefinition[];
  readonly rawPositionals: readonly string[];
}): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  positionals.forEach((positional, index) => {
    result[positional.key] = validateInputValue({
      appName,
      command,
      input: positional,
      rawValue: rawPositionals[index],
      missingMessage: `missing required argument ${positional.valueName}`,
    });
  });
  return result;
}
