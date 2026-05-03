import type { CliAnyCommandDefinition } from "@alea/lib/cli/types";

/**
 * One-line usage string: `alea candles:sync [options] <SYMBOL>`.
 */
export function formatCommandUsage({
  appName,
  command,
}: {
  readonly appName: string;
  readonly command: CliAnyCommandDefinition;
}): string {
  const parts = [appName, command.name];
  if (command.options && command.options.length > 0) {
    parts.push("[options]");
  }
  for (const positional of command.positionals ?? []) {
    parts.push(`<${positional.valueName}>`);
  }
  return parts.join(" ");
}
