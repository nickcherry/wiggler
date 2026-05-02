import type { DatabaseClient } from "@wiggler/lib/db/types";
import { FileMigrationProvider, Migrator } from "kysely";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const migrationFolder = path.join(import.meta.dir, "migrations");

/**
 * Builds a Kysely Migrator pointed at the on-disk migrations folder.
 */
export function createMigrator({ db }: { readonly db: DatabaseClient }): Migrator {
  return new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder,
    }),
  });
}
