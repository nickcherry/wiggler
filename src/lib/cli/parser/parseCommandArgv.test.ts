import { CliUsageError } from "@alea/lib/cli/CliUsageError";
import { defineCommand } from "@alea/lib/cli/defineCommand";
import { defineFlagOption } from "@alea/lib/cli/defineFlagOption";
import { definePositional } from "@alea/lib/cli/definePositional";
import { defineValueOption } from "@alea/lib/cli/defineValueOption";
import { parseCommandArgv } from "@alea/lib/cli/parser/parseCommandArgv";
import { describe, expect, it } from "bun:test";
import { z } from "zod";

const command = defineCommand({
  name: "demo",
  summary: "Demo command",
  description: "Exercises the parser.",
  options: [
    defineValueOption({
      key: "limit",
      long: "--limit",
      short: "-l",
      valueName: "N",
      schema: z.coerce.number().int().positive(),
    }),
    defineFlagOption({
      key: "verbose",
      long: "--verbose",
      short: "-v",
      schema: z.boolean().optional().default(false),
    }),
  ],
  positionals: [
    definePositional({
      key: "asset",
      valueName: "ASSET",
      schema: z.enum(["btc", "eth"]),
    }),
  ],
  output: "None.",
  sideEffects: "None.",
  async run() {},
});

describe("parseCommandArgv", () => {
  it("parses long inline values, short flags, and positionals", () => {
    expect(
      parseCommandArgv({
        appName: "alea",
        command,
        argv: ["--limit=3", "-v", "btc"],
      }),
    ).toEqual({
      options: { limit: 3, verbose: true },
      positionals: { asset: "btc" },
    });
  });

  it("parses short value options from the following token", () => {
    expect(
      parseCommandArgv({
        appName: "alea",
        command,
        argv: ["-l", "5", "eth"],
      }).options,
    ).toEqual({ limit: 5, verbose: false });
  });

  it("treats tokens after -- as positionals even when they start with dash", () => {
    const commandWithDashyPositional = defineCommand({
      name: "dashy",
      summary: "Dash positional",
      description: "Allows a dash-prefixed positional.",
      options: [
        defineValueOption({
          key: "limit",
          long: "--limit",
          valueName: "N",
          schema: z.coerce.number().int().positive(),
        }),
      ],
      positionals: [
        definePositional({
          key: "name",
          valueName: "NAME",
          schema: z.string(),
        }),
      ],
      output: "None.",
      sideEffects: "None.",
      async run() {},
    });

    expect(
      parseCommandArgv({
        appName: "alea",
        command: commandWithDashyPositional,
        argv: ["--limit", "2", "--", "--not-an-option"],
      }),
    ).toEqual({
      options: { limit: 2 },
      positionals: { name: "--not-an-option" },
    });
  });

  it("throws a usage error for unknown, duplicate, missing, and invalid inputs", () => {
    expect(() =>
      parseCommandArgv({
        appName: "alea",
        command,
        argv: ["--unknown", "--limit", "1", "btc"],
      }),
    ).toThrow(CliUsageError);

    expect(() =>
      parseCommandArgv({
        appName: "alea",
        command,
        argv: ["--limit", "1", "-l", "2", "btc"],
      }),
    ).toThrow(/duplicate option/);

    expect(() =>
      parseCommandArgv({
        appName: "alea",
        command,
        argv: ["--limit"],
      }),
    ).toThrow(/missing value/);

    expect(() =>
      parseCommandArgv({
        appName: "alea",
        command,
        argv: ["--limit", "0", "btc"],
      }),
    ).toThrow(/--limit is invalid/);
  });

  it("throws a usage error for missing and extra positionals", () => {
    expect(() =>
      parseCommandArgv({
        appName: "alea",
        command,
        argv: ["--limit", "1"],
      }),
    ).toThrow(/missing required argument ASSET/);

    expect(() =>
      parseCommandArgv({
        appName: "alea",
        command,
        argv: ["--limit", "1", "btc", "extra"],
      }),
    ).toThrow(/unexpected argument/);
  });
});
