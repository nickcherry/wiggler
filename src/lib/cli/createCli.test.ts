import { CliUsageError } from "@alea/lib/cli/CliUsageError";
import { createCli } from "@alea/lib/cli/createCli";
import { defineCommand } from "@alea/lib/cli/defineCommand";
import { defineFlagOption } from "@alea/lib/cli/defineFlagOption";
import { definePositional } from "@alea/lib/cli/definePositional";
import { defineValueOption } from "@alea/lib/cli/defineValueOption";
import type { CliIo } from "@alea/lib/cli/types";
import { describe, expect, it } from "bun:test";
import { z } from "zod";

function captureIo(): {
  readonly io: CliIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      writeStdout(text) {
        stdout += text;
      },
      writeStderr(text) {
        stderr += text;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("createCli", () => {
  it("renders top-level help for empty argv and hides hidden commands", async () => {
    const visible = defineCommand({
      name: "visible",
      summary: "Visible command",
      description: "Visible details.",
      output: "None.",
      sideEffects: "None.",
      async run() {},
    });
    const hidden = defineCommand({
      name: "hidden",
      summary: "Hidden command",
      description: "Hidden details.",
      output: "None.",
      sideEffects: "None.",
      hidden: true,
      async run() {},
    });
    const app = createCli({
      name: "alea-test",
      summary: "Test app",
      commands: [hidden, visible],
    });
    const capture = captureIo();

    await app.run([], capture.io);

    expect(capture.stdout()).toContain("alea-test");
    expect(capture.stdout()).toContain("help");
    expect(capture.stdout()).toContain("visible");
    expect(capture.stdout()).not.toContain("hidden");
    expect(capture.stderr()).toBe("");
  });

  it("runs a command with typed parsed inputs and raw argv", async () => {
    const app = createCli({
      name: "alea-test",
      summary: "Test app",
      commands: [
        defineCommand({
          name: "trade",
          summary: "Trade",
          description: "Trade command.",
          options: [
            defineValueOption({
              key: "limit",
              long: "--limit",
              valueName: "N",
              schema: z.coerce.number().int().positive(),
            }),
            defineFlagOption({
              key: "dryRun",
              long: "--dry-run",
              short: "-n",
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
          output: "Writes the parsed values.",
          sideEffects: "None.",
          async run({ io, options, positionals, rawArgv }) {
            io.writeStdout(
              `${positionals.asset}:${options.limit}:${options.dryRun}:${rawArgv.join(",")}`,
            );
          },
        }),
      ],
    });
    const capture = captureIo();

    await app.run(["trade", "btc", "--limit", "7", "-n"], capture.io);

    expect(capture.stdout()).toBe("btc:7:true:btc,--limit,7,-n");
  });

  it("renders detailed command help without running the command", async () => {
    let ran = false;
    const app = createCli({
      name: "alea-test",
      summary: "Test app",
      commands: [
        defineCommand({
          name: "visible",
          summary: "Visible command",
          description: "Visible details.",
          output: "None.",
          sideEffects: "None.",
          async run() {
            ran = true;
          },
        }),
      ],
    });
    const capture = captureIo();

    await app.run(["visible", "--help"], capture.io);

    expect(capture.stdout()).toContain("visible");
    expect(capture.stdout()).toContain("Usage:");
    expect(ran).toBe(false);
  });

  it("throws usage errors for unknown commands and unknown help targets", () => {
    const app = createCli({
      name: "alea-test",
      summary: "Test app",
      commands: [],
    });

    expect(() => app.renderCommandHelp("missing")).toThrow(CliUsageError);
    expect(app.run(["missing"], captureIo().io)).rejects.toThrow(CliUsageError);
  });

  it("rejects duplicate commands and reserved option flags at construction", () => {
    const first = defineCommand({
      name: "same",
      summary: "First",
      description: "First.",
      output: "None.",
      sideEffects: "None.",
      async run() {},
    });
    const second = defineCommand({
      name: "same",
      summary: "Second",
      description: "Second.",
      output: "None.",
      sideEffects: "None.",
      async run() {},
    });

    expect(() =>
      createCli({
        name: "alea-test",
        summary: "Test app",
        commands: [first, second],
      }),
    ).toThrow(/duplicate CLI command/);

    expect(() =>
      createCli({
        name: "alea-test",
        summary: "Test app",
        commands: [
          defineCommand({
            name: "bad",
            summary: "Bad",
            description: "Bad.",
            options: [
              defineFlagOption({
                key: "help",
                long: "--help",
                schema: z.boolean().optional().default(false),
              }),
            ],
            output: "None.",
            sideEffects: "None.",
            async run() {},
          }),
        ],
      }),
    ).toThrow(/reserved CLI flag/);
  });
});
