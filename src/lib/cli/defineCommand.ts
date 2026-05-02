import type {
  CliCommandDefinition,
  CliOptionDefinition,
  CliPositionalDefinition,
} from "@wiggler/lib/cli/types";

/**
 * Identity helper that ties a command's option types to the values its
 * `run` callback receives. Use this to declare every CLI command.
 */
export function defineCommand<
  const TOptions extends readonly CliOptionDefinition[],
  const TPositionals extends readonly CliPositionalDefinition[],
>(
  command: CliCommandDefinition<TOptions, TPositionals>,
): CliCommandDefinition<TOptions, TPositionals> {
  return command;
}
