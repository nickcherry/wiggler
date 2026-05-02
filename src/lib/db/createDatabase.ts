import { env } from "@wiggler/constants/env";
import type { Database, DatabaseClient } from "@wiggler/lib/db/types";
import { Kysely, PostgresDialect } from "kysely";
import { Pool, type PoolConfig } from "pg";
import Cursor from "pg-cursor";

/**
 * Creates the single PostgreSQL-backed Kysely client used by application and
 * migration code. Caller owns the client lifetime — call `destroyDatabase`
 * when finished.
 */
export function createDatabase(): DatabaseClient {
  const poolConfig: PoolConfig = {
    connectionString: env.databaseUrl,
  };
  const poolMax = env.databasePoolMax;

  if (poolMax !== undefined) {
    poolConfig.max = poolMax;
  }

  return new Kysely<Database>({
    dialect: new PostgresDialect({
      cursor: Cursor,
      pool: new Pool(poolConfig),
    }),
  });
}
