import { createDatabase } from "@alea/lib/db/createDatabase";
import { createMigrator } from "@alea/lib/db/createMigrator";
import { destroyDatabase } from "@alea/lib/db/destroyDatabase";
import type { MigrationResult } from "kysely";

export type RunMigrationsToLatestResult = {
  readonly applied: readonly MigrationResult[];
};

/**
 * Applies any pending migrations against the configured database. Throws if
 * Kysely returns an error or any individual migration result is non-success.
 */
export async function runMigrationsToLatest(): Promise<RunMigrationsToLatestResult> {
  const db = createDatabase();
  try {
    const migrator = createMigrator({ db });
    const { error, results } = await migrator.migrateToLatest();

    if (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`migration error: ${JSON.stringify(error)}`);
    }

    const applied = results ?? [];
    const failures = applied.filter((result) => result.status !== "Success");
    if (failures.length > 0) {
      const summary = failures
        .map((failure) => `${failure.migrationName}: ${failure.status}`)
        .join(", ");
      throw new Error(`migration failures: ${summary}`);
    }

    return { applied };
  } finally {
    await destroyDatabase(db);
  }
}
