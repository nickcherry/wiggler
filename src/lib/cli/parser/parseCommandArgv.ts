import { CliUsageError } from "@alea/lib/cli/CliUsageError";
import { parseOptionToken } from "@alea/lib/cli/parser/parseOptionToken";
import { validateOptions } from "@alea/lib/cli/parser/validateOptions";
import { validatePositionals } from "@alea/lib/cli/parser/validatePositionals";
import { formatCommandUsage } from "@alea/lib/cli/render/formatCommandUsage";
import type { CliAnyCommandDefinition } from "@alea/lib/cli/types";

export type ParsedCommandInput = {
  readonly options: Record<string, unknown>;
  readonly positionals: Record<string, unknown>;
};

/**
 * Parses a raw argv array against a command definition, resolving options and
 * positional arguments into typed values. Supports `--key=value`, `--key
 * value`, short options, boolean flags, and `--` to terminate option parsing.
 * Throws `CliUsageError` on unknown options, duplicate options, missing
 * values, or too many positional arguments.
 */
export function parseCommandArgv({
  appName,
  command,
  argv,
}: {
  readonly appName: string;
  readonly command: CliAnyCommandDefinition;
  readonly argv: readonly string[];
}): ParsedCommandInput {
  const options = command.options ?? [];
  const positionals = command.positionals ?? [];
  const longOptions = new Map(options.map((option) => [option.long, option]));
  const shortOptions = new Map(
    options.flatMap((option) =>
      option.short ? [[option.short, option] as const] : [],
    ),
  );
  const rawOptionValues = new Map<string, unknown>();
  const rawPositionals: string[] = [];
  let parsingPositionalsOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token) {
      continue;
    }

    if (!parsingPositionalsOnly && token === "--") {
      parsingPositionalsOnly = true;
      continue;
    }

    if (!parsingPositionalsOnly && token.startsWith("-")) {
      const parsed = parseOptionToken({ token, longOptions, shortOptions });

      if (!parsed.option) {
        throw new CliUsageError(
          `unknown option for ${command.name}: ${token}`,
          formatCommandUsage({ appName, command }),
        );
      }

      if (rawOptionValues.has(parsed.option.key)) {
        throw new CliUsageError(
          `duplicate option for ${command.name}: ${parsed.option.long}`,
          formatCommandUsage({ appName, command }),
        );
      }

      if (parsed.option.kind === "flag") {
        rawOptionValues.set(parsed.option.key, true);
        continue;
      }

      const value = parsed.inlineValue ?? argv[index + 1];

      if (value === undefined) {
        throw new CliUsageError(
          `missing value for option ${parsed.option.long}`,
          formatCommandUsage({ appName, command }),
        );
      }

      if (parsed.inlineValue === undefined) {
        index += 1;
      }

      rawOptionValues.set(parsed.option.key, value);
      continue;
    }

    rawPositionals.push(token);
  }

  if (rawPositionals.length > positionals.length) {
    throw new CliUsageError(
      `unexpected argument for ${command.name}: ${rawPositionals[positionals.length]}`,
      formatCommandUsage({ appName, command }),
    );
  }

  return {
    options: validateOptions({
      appName,
      command,
      options,
      rawOptionValues,
    }),
    positionals: validatePositionals({
      appName,
      command,
      positionals,
      rawPositionals,
    }),
  };
}
