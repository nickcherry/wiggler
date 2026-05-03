# Coding Conventions

## Key Principles

- Optimize for reviewability. Names, structure, and control flow should make intent clear without prose.
- Type safety is required. Do not use `any`. Do not paper over weak inference with `as` casts in normal application flow.
- Prefer simple, obvious code over clever abstractions.
- Documentation expectations live in [DOCUMENTATION.md](./DOCUMENTATION.md).
- CLI architecture and behavior live in [CLI.md](./CLI.md).
- Collaboration expectations live in [HOW_TO_WORK_WITH_NICK.md](./HOW_TO_WORK_WITH_NICK.md).

## Stack

- Bun for runtime, package management, and the CLI entrypoint. No Node-only flows.
- TypeScript with strict static validation through `tsc`. `noUncheckedIndexedAccess` is on.
- Zod for boundary validation and schema-first typing.
- PostgreSQL for persistence.
- Kysely for type-safe SQL and schema migrations; `pg` as the driver.
- No Python, no extended shell scripting. Anything that doesn't belong in the CLI binary is still TypeScript.

## Repository Layout

- Source code lives under `src/`.
- CLI entrypoints live under `src/bin/`. One file per command, grouped into family directories such as `src/bin/db/` and `src/bin/candles/`.
- Domain constants live under `src/constants/`.
- Reusable application logic lives under `src/lib/`.
- Broadly reused domain types live under `src/types/`.
- Database access lives under `src/lib/db/`.
- Database schema changes are managed through TypeScript migrations under `src/lib/db/migrations/`.
- Internal engineering and architecture docs live under `doc/`.
- Scratch files and temporary artifacts must not live in the repository. Use `/tmp` for one-offs.

## Modules And Files

- Use named exports only. Do not use default exports.
- Prefer one exported function per file. Multiple exported constants in one file are fine when they belong together (for example, an enum-like list of values).
- Name files after the primary exported symbol when practical. For exported-function files, use camelCase filenames that match the exported symbol.
- Keep imports static and at the top of the file. Do not use dynamic `import()`.
- Prefer absolute internal imports via `@alea/*` instead of deep relative paths.
- Group imports by source: third-party first, then `@alea/*`, then local relatives if any. The TypeScript and Bun toolchain will tolerate either ordering, but consistency makes diffs cleaner.

## Function And API Design

- Prefer object parameters for public functions, even when there is currently only one argument. Future arguments slot in without breaking call sites.
- Use explicit return types on exported functions. Inferred return types are fine on local helpers.
- Mark object parameter properties `readonly` when the function does not mutate them.
- Keep functions small enough that their behavior is obvious without scrolling through unrelated logic.
- If a function needs multiple modes or branches, split it before adding more flags.
- Make invalid states hard to represent through types and schemas rather than defensive comments.

## Code Style

- Prefer early returns over deeply nested conditionals.
- Prefer immutable local values unless mutation materially improves clarity or performance.
- Keep branching and loops straightforward.
- Use comments sparingly. Add them only when the code is not self-explanatory: a hidden constraint, a subtle invariant, a workaround for a specific bug, behavior that would surprise a reader.
- Favor descriptive names over abbreviations.

## Types And Errors

- Start with a Zod schema when data crosses a boundary such as CLI input, config, environment, or external API responses.
- Derive TypeScript types from schemas with `z.infer` when appropriate.
- Prefer narrow unions and specific object types over broad string or record shapes.
- Avoid optional fields unless they are meaningfully optional. A field that is "always set after step X" is not the same as `T | undefined`.
- File-local types that are truly throwaway and only used in one implementation file may stay in that file.
- Types shared within a small, confined area should live in that area's `types.ts`.
- Types that are broadly reused should live in `src/types/<domain>.ts`.
- Shared errors should live in dedicated single-purpose files (for example, `CliUsageError.ts`). Local one-off errors can stay in the file that throws them.
- Start local and promote only when reuse justifies it. Do not mix shared types or shared errors with implementation code.

## Testing

- Every function that can be reasonably unit tested should be.
- Prefer many small, tight, fast unit tests over broad slow tests.
- Tests should be pure and deterministic. Isolate or remove dependencies on time, randomness, network access, and other uncontrolled side effects.
- Do not test systems outside the process boundary in unit tests. Do not touch the database or external APIs in tests.
- Place tests next to the code they exercise (`foo.ts` and `foo.test.ts` in the same directory).

## Dependencies And Boundaries

- Add dependencies reluctantly. Prefer the standard library or existing repo utilities first.
- Keep boundary code isolated. Validation, parsing, formatting, and IO should not be spread through unrelated business logic.
- Avoid hidden coupling between CLI code and reusable library code. CLI files in `src/bin/` should be thin glue: parse → call lib → format result.
- Access environment variables through `src/constants/env.ts` so external dependencies stay discoverable in one place.
- Keep logs high signal and error messages actionable. For long-running bulk jobs, prefer periodic progress updates over per-item log spam.
- Be explicit about concurrency semantics. Async fan-out (`Promise.all`) is not the same thing as true multi-core execution.

## CLI Conventions

See [CLI.md](./CLI.md) for the full command-authoring contract. Highlights:

- One entrypoint: `bun alea`.
- Every command is a `defineCommand({ ... })` value with summary, description, options, examples, output, and side-effects.
- Every option and positional carries a Zod schema; that schema is the only place coercion lives.
- Command files stay thin. Domain logic lives in `src/lib/`.

## File Complexity

- Keep files small enough to read end-to-end. If a file is hard to skim, split it before adding more features.
- The standard refactor pattern is to convert a file into a folder and add an `index.ts` that re-exports the same public API, so existing import paths continue to work.
- Tests always move with the code they exercise.
- These refactors should not change behavior.
