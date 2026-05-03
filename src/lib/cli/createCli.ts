import { CliUsageError } from "@wiggler/lib/cli/CliUsageError";
import { defineCommand } from "@wiggler/lib/cli/defineCommand";
import { definePositional } from "@wiggler/lib/cli/definePositional";
import { parseCommandArgv } from "@wiggler/lib/cli/parser/parseCommandArgv";
import { formatTopLevelUsage } from "@wiggler/lib/cli/render/formatTopLevelUsage";
import { renderAppHelp } from "@wiggler/lib/cli/render/renderAppHelp";
import { renderCommandHelp } from "@wiggler/lib/cli/render/renderCommandHelp";
import type {
  CliAnyCommandDefinition,
  CliApp,
  CliAppDefinition,
  CliIo,
} from "@wiggler/lib/cli/types";
import pc from "picocolors";
import { z } from "zod";

const defaultIo: CliIo = {
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

/**
 * Builds the application object that backs the CLI binary. Adds a built-in
 * `help` command and exposes both a raw `run` and a `runWithErrorBoundary`
 * suitable for direct use from `process.argv`.
 */
export function createCli(definition: CliAppDefinition): CliApp {
  const allCommands = [
    ...buildBuiltInCommands(definition),
    ...definition.commands,
  ];
  const commandsByName = new Map<string, CliAnyCommandDefinition>(
    allCommands.map((command) => [command.name, command]),
  );
  validateCommands({ commands: allCommands });

  const fullDefinition: CliAppDefinition = {
    ...definition,
    commands: allCommands,
  };

  const renderFullAppHelp = (): string =>
    renderAppHelp({ appDefinition: fullDefinition });

  const renderHelpForCommand = (commandName: string): string => {
    const command = commandsByName.get(commandName);
    if (!command) {
      throw new CliUsageError(
        `unknown command: ${commandName}`,
        formatTopLevelUsage({ appName: definition.name }),
      );
    }
    return renderCommandHelp({ appName: definition.name, command });
  };

  const run = async (
    argv: readonly string[],
    io: CliIo = defaultIo,
  ): Promise<void> => {
    const commandName = argv[0];

    if (commandName === undefined || isHelpFlag(commandName)) {
      io.writeStdout(`${renderFullAppHelp()}\n`);
      return;
    }

    const command = commandsByName.get(commandName);
    if (!command) {
      throw new CliUsageError(
        `unknown command: ${commandName}`,
        formatTopLevelUsage({ appName: definition.name }),
      );
    }

    const rawArgv = argv.slice(1);
    if (rawArgv.some(isHelpFlag)) {
      io.writeStdout(
        `${renderCommandHelp({ appName: definition.name, command })}\n`,
      );
      return;
    }

    const parsed = parseCommandArgv({
      appName: definition.name,
      command,
      argv: rawArgv,
    });

    await command.run({
      io,
      options: parsed.options,
      positionals: parsed.positionals,
      rawArgv,
    });
  };

  const runWithErrorBoundary = async (
    argv: readonly string[],
    io: CliIo = defaultIo,
  ): Promise<void> => {
    try {
      await run(argv, io);
    } catch (error: unknown) {
      if (error instanceof CliUsageError) {
        io.writeStderr(`${pc.red("error:")} ${error.message}\n`);
        if (error.usage) {
          io.writeStderr(`${pc.dim("usage:")} ${error.usage}\n`);
        }
        process.exit(1);
      }
      io.writeStderr(
        `${pc.red("error:")} ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exit(1);
    }
  };

  return {
    run,
    runWithErrorBoundary,
    renderAppHelp: renderFullAppHelp,
    renderCommandHelp: renderHelpForCommand,
  };

  function buildBuiltInCommands(
    appDefinition: CliAppDefinition,
  ): readonly CliAnyCommandDefinition[] {
    return [
      defineCommand({
        name: "help",
        summary: "Show CLI help",
        description:
          "Print top-level help or detailed help for a specific command without running the command.",
        positionals: [
          definePositional({
            key: "commandName",
            valueName: "COMMAND",
            schema: z.string().optional().describe("Command name to inspect."),
          }),
        ],
        examples: [
          `${appDefinition.name} help`,
          `${appDefinition.name} help candles:sync`,
        ],
        output: "Prints CLI help text to stdout.",
        sideEffects: "None.",
        async run({ io, positionals }) {
          const commandName = positionals.commandName;
          if (typeof commandName === "string" && commandName.length > 0) {
            io.writeStdout(`${renderHelpForCommand(commandName)}\n`);
            return;
          }
          io.writeStdout(`${renderFullAppHelp()}\n`);
        },
      }),
    ];
  }
}

function isHelpFlag(token: string): boolean {
  return token === "--help" || token === "-h";
}

function validateCommands({
  commands,
}: {
  readonly commands: readonly CliAnyCommandDefinition[];
}): void {
  const names = new Set<string>();
  for (const command of commands) {
    if (names.has(command.name)) {
      throw new Error(`duplicate CLI command definition: ${command.name}`);
    }
    names.add(command.name);
    validateCommandOptions({ command });
  }
}

function validateCommandOptions({
  command,
}: {
  readonly command: CliAnyCommandDefinition;
}): void {
  const reservedFlags = new Set(["--help", "-h"]);
  const seenFlags = new Set<string>();
  const seenKeys = new Set<string>();

  for (const option of command.options ?? []) {
    if (seenKeys.has(option.key)) {
      throw new Error(`duplicate option key in ${command.name}: ${option.key}`);
    }
    seenKeys.add(option.key);

    const flags = option.short ? [option.long, option.short] : [option.long];
    for (const flag of flags) {
      if (reservedFlags.has(flag)) {
        throw new Error(`reserved CLI flag used in ${command.name}: ${flag}`);
      }
      if (seenFlags.has(flag)) {
        throw new Error(`duplicate option flag in ${command.name}: ${flag}`);
      }
      seenFlags.add(flag);
    }
  }
}
