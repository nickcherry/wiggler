import type {
  CliOptionDefinition,
  CliPositionalDefinition,
} from "@wiggler/lib/cli/types";

/**
 * Human-readable label for an option or positional, used in error messages.
 */
export function getInputLabel(
  input: CliOptionDefinition | CliPositionalDefinition,
): string {
  if ("long" in input) {
    return input.long;
  }
  return input.valueName;
}
