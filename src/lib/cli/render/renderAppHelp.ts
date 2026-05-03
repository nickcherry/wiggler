import { formatTopLevelUsage } from "@wiggler/lib/cli/render/formatTopLevelUsage";
import type { CliAppDefinition } from "@wiggler/lib/cli/types";
import pc from "picocolors";

/**
 * Top-level help: summary, usage, list of visible commands grouped by name.
 */
export function renderAppHelp({
  appDefinition,
}: {
  readonly appDefinition: CliAppDefinition;
}): string {
  const lines: string[] = [];
  lines.push(
    `${pc.bold(appDefinition.name)} ${pc.dim("—")} ${appDefinition.summary}`,
  );
  lines.push("");
  lines.push(
    `${pc.dim("Usage:")} ${formatTopLevelUsage({ appName: appDefinition.name })}`,
  );
  lines.push("");

  const visibleCommands = appDefinition.commands.filter(
    (command) => !command.hidden,
  );
  const sorted = [...visibleCommands].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const longestName = sorted.reduce(
    (max, command) => Math.max(max, command.name.length),
    0,
  );

  lines.push(pc.bold("Commands:"));
  for (const command of sorted) {
    lines.push(
      `  ${pc.cyan(command.name.padEnd(longestName + 2))}${command.summary}`,
    );
  }
  lines.push("");
  lines.push(
    pc.dim(`Run \`${appDefinition.name} help <command>\` for details.`),
  );

  return lines.join("\n");
}
