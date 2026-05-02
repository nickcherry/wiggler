import type { DatabaseClient } from "@wiggler/lib/db/types";

/**
 * Closes all pooled database connections owned by a Kysely client.
 */
export async function destroyDatabase(db: DatabaseClient): Promise<void> {
  await db.destroy();
}
