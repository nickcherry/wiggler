import { runMigrationsToLatest } from "@wiggler/lib/db/runMigrationsToLatest";

/**
 * CLI handler: applies any pending migrations and prints a one-line summary.
 */
export async function runDbMigrate(): Promise<void> {
  const { applied } = await runMigrationsToLatest();

  if (applied.length === 0) {
    console.log("no migrations pending");
    return;
  }

  for (const result of applied) {
    console.log(`applied: ${result.migrationName}`);
  }
}
