import { CliUsageError } from "@alea/lib/cli/CliUsageError";
import { getInputLabel } from "@alea/lib/cli/parser/getInputLabel";
import { formatCommandUsage } from "@alea/lib/cli/render/formatCommandUsage";
import type {
  CliAnyCommandDefinition,
  CliOptionDefinition,
  CliPositionalDefinition,
} from "@alea/lib/cli/types";
import { ZodError } from "zod";

/**
 * Coerces a raw argv string into a typed value via the input's Zod schema,
 * translating missing-required and schema-rejection cases into
 * `CliUsageError`.
 */
export function validateInputValue({
  appName,
  command,
  input,
  rawValue,
  missingMessage,
}: {
  readonly appName: string;
  readonly command: CliAnyCommandDefinition;
  readonly input: CliOptionDefinition | CliPositionalDefinition;
  readonly rawValue: unknown;
  readonly missingMessage: string;
}): unknown {
  if (rawValue === undefined && !input.schema.safeParse(undefined).success) {
    throw new CliUsageError(
      missingMessage,
      formatCommandUsage({ appName, command }),
    );
  }

  try {
    return input.schema.parse(rawValue);
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      throw new CliUsageError(
        `${getInputLabel(input)} is invalid: ${error.issues[0]?.message ?? "invalid value"}`,
        formatCommandUsage({ appName, command }),
      );
    }
    throw error;
  }
}
