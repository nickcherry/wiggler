# CLI

The CLI is the operator-facing contract for Alea.

Everything that matters is reachable through one non-interactive entrypoint:

`bun alea`

(or, when the `bin` is on PATH, just `alea`).

## Core Rules

- Use one entrypoint: `bun alea`.
- Operator workflows belong under `bun alea <command>`, not ad hoc package scripts.
- `package.json` scripts are for repo maintenance only: typecheck, test, format, and the `alea` wrapper.
- Commands must stay non-interactive by default.
- Help output must be enough for a human or agent to understand side effects before running the command.
- Parsing and validation belong in the command definition (Zod schemas on every option/positional), not in downstream business logic.
- Shared CLI mechanics live in `src/lib/cli/`.
- Domain logic lives outside command files; command files should stay thin glue between input parsing and library code.

## Active Command Families

- `db:*`
  `db:migrate`
- `candles:*`
  `candles:sync`
  `candles:fill-gaps`
- `latency:*`
  `latency:capture`
  `latency:chart`
- `training:*`
  `training:distributions`
- `telegram:*`
  `telegram:test`
- `polymarket:*`
  `polymarket:auth-check`
- `trading:*`
  `trading:gen-probability-table`
  `trading:dry-run`
- `help`
  Built-in. `alea help <command>` prints detailed help; `alea help` is equivalent to `alea` with no arguments.

This list is expected to grow as the simplification progresses. Update this section whenever a new family or command is registered in `src/bin/index.ts`.

## Adding A Command

1. Decide the family and pick a name like `family:verb`.
2. Create the command file under `src/bin/<family>/<verb>.ts`. Export a single named `<family><Verb>Command` value built with `defineCommand({ ... })`.
3. Express every input as a Zod schema on a `defineValueOption` / `defineFlagOption` / `definePositional`. The schema controls coercion, defaulting, and required-vs-optional semantics — there should be no manual argv parsing in the command body.
4. Fill `summary`, `description`, `examples`, `output`, and `sideEffects`. These are part of the public CLI surface.
5. Implement `run({ io, options, positionals })` so it calls into `src/lib/<domain>/` for the actual work and writes results via `io.writeStdout`.
6. Register the new command in the `commands` array passed to `createCli` in `src/bin/index.ts`.
7. Update this doc's "Active Command Families" section.

## Output Style

CLI output is a product surface — humans (and human-like agents) read it. Aim for output that is **clean, nicely organized, and friendly to read**.

- Lead with the most important fact (what happened, what changed) and put numeric or tabular detail underneath.
- Group related lines and use blank lines as section separators rather than ASCII rules.
- Prefer compact, aligned columns over flowing prose for repeated rows. Pad with `String.padStart` / `padEnd` rather than ad-hoc spaces.
- Use units consistently within a single command (always ms vs always s, always rows vs always candles).
- Plain `info` lines do not need color. Reserve color for genuine signal:
  - **green** — successful completion or a positive metric.
  - **yellow** — warning, dry-run, or skipped work.
  - **red** — error or sharply negative metric.
  - **dim/gray** — secondary information (timestamps, file paths, hints).
- Use **[picocolors](https://github.com/alexeyraspopov/picocolors)** for ANSI styling. It is the only color dependency. Import as `import pc from "picocolors"` and call `pc.green(...)`, `pc.dim(...)`, etc. Picocolors auto-disables when the stream is not a TTY, so you do not need to gate calls manually.
- Do not write color escape codes by hand. Do not pull in `chalk`, `kleur`, `ansis`, or similar — picocolors covers our needs.
- Errors must still be readable when color is disabled (`NO_COLOR=1` or piped output): rely on the wording to carry meaning, with color only as emphasis.

## Help Output

- `bun alea` and `bun alea help` print the top-level command list.
- `bun alea <command> --help`, `bun alea <command> -h`, and `bun alea help <command>` all print detailed help for one command.
- Detailed help shows summary, usage, description, arguments, options (with descriptions pulled from each input's Zod `.describe(...)` text), examples, output description, and side effects.

## Error Handling

- `CliUsageError` (unknown command, missing required option, invalid value, etc.) prints `error: <msg>` and a `usage:` line to stderr, then exits 1.
- Zod validation failures from option schemas are translated into `CliUsageError` before bubbling out.
- Any other thrown error is printed to stderr with its stack and exit code 1.

## Library Layout

- `src/lib/cli/types.ts` — public command/option/positional types.
- `src/lib/cli/defineCommand.ts`, `defineValueOption.ts`, `defineFlagOption.ts`, `definePositional.ts` — identity helpers that anchor TypeScript inference for command authors.
- `src/lib/cli/parser/` — argv → typed `{ options, positionals }` via Zod.
- `src/lib/cli/render/` — top-level help, per-command help, usage strings.
- `src/lib/cli/createCli.ts` — wires the app definition to a runner with built-in `help` and an error boundary.
- `src/lib/cli/CliUsageError.ts` — usage error class.
