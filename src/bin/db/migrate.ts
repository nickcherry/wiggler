import { defineCommand } from "@alea/lib/cli/defineCommand";
import { runMigrationsToLatest } from "@alea/lib/db/runMigrationsToLatest";
import pc from "picocolors";

/**
 * Applies all pending Kysely database migrations.
 */
export const dbMigrateCommand = defineCommand({
  name: "db:migrate",
  summary: "Apply pending database migrations",
  description:
    "Run all pending PostgreSQL schema migrations against the configured database.",
  examples: [
    "bun alea db:migrate",
    "DATABASE_URL=postgres://localhost:5432/alea bun alea db:migrate",
  ],
  output: "Prints each applied migration name, or `no migrations pending`.",
  sideEffects:
    "Connects to PostgreSQL and mutates database schema by applying pending migrations.",
  async run({ io }) {
    const { applied } = await runMigrationsToLatest();

    if (applied.length === 0) {
      io.writeStdout(`${pc.green("ok")}  no migrations pending\n`);
      return;
    }

    for (const result of applied) {
      io.writeStdout(`${pc.green("applied")}  ${result.migrationName}\n`);
    }
  },
});
