import pc from "picocolors";
import { formatCommandUsage } from "@wiggler/lib/cli/render/formatCommandUsage";
import type {
  CliAnyCommandDefinition,
  CliOptionDefinition,
  CliPositionalDefinition,
} from "@wiggler/lib/cli/types";

/**
 * Renders detailed help for one command: summary, usage, options, positionals,
 * description, examples, output, and side-effects.
 */
export function renderCommandHelp({
  appName,
  command,
}: {
  readonly appName: string;
  readonly command: CliAnyCommandDefinition;
}): string {
  const lines: string[] = [];
  lines.push(`${pc.bold(command.name)} ${pc.dim("—")} ${command.summary}`);
  lines.push("");
  lines.push(`${pc.dim("Usage:")} ${formatCommandUsage({ appName, command })}`);
  lines.push("");

  if (command.description) {
    lines.push(command.description);
    lines.push("");
  }

  if (command.positionals && command.positionals.length > 0) {
    lines.push(pc.bold("Arguments:"));
    for (const positional of command.positionals) {
      lines.push(
        `  ${pc.cyan(positional.valueName.padEnd(18))} ${describeInput({ input: positional })}`,
      );
    }
    lines.push("");
  }

  if (command.options && command.options.length > 0) {
    lines.push(pc.bold("Options:"));
    for (const option of command.options) {
      lines.push(
        `  ${pc.cyan(formatOption({ option }).padEnd(28))} ${describeInput({ input: option })}`,
      );
    }
    lines.push("");
  }

  if (command.examples && command.examples.length > 0) {
    lines.push(pc.bold("Examples:"));
    for (const example of command.examples) {
      lines.push(`  ${pc.dim(example)}`);
    }
    lines.push("");
  }

  lines.push(`${pc.dim("Output:")} ${command.output}`);
  lines.push(`${pc.dim("Side effects:")} ${command.sideEffects}`);

  return lines.join("\n");
}

function describeInput({
  input,
}: {
  readonly input: CliOptionDefinition | CliPositionalDefinition;
}): string {
  if (input.description) {
    return input.description;
  }
  const schemaDescription = (input.schema as { description?: unknown })
    .description;
  if (typeof schemaDescription === "string" && schemaDescription.length > 0) {
    return schemaDescription;
  }
  return "";
}

function formatOption({ option }: { readonly option: CliOptionDefinition }): string {
  const flag = option.short ? `${option.short}, ${option.long}` : option.long;
  if (option.kind === "flag") {
    return flag;
  }
  return `${flag} <${option.valueName}>`;
}
