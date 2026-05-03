import { validateInputValue } from "@alea/lib/cli/parser/validateInputValue";
import type {
  CliAnyCommandDefinition,
  CliOptionDefinition,
} from "@alea/lib/cli/types";

/**
 * Validates and coerces all option values for a parsed command. Returns a
 * plain object keyed by `option.key`.
 */
export function validateOptions({
  appName,
  command,
  options,
  rawOptionValues,
}: {
  readonly appName: string;
  readonly command: CliAnyCommandDefinition;
  readonly options: readonly CliOptionDefinition[];
  readonly rawOptionValues: ReadonlyMap<string, unknown>;
}): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const option of options) {
    result[option.key] = validateInputValue({
      appName,
      command,
      input: option,
      rawValue: rawOptionValues.get(option.key),
      missingMessage: `missing required option ${option.long}`,
    });
  }
  return result;
}
