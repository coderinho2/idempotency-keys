import { readFileSync } from "node:fs";
import type { Database, Queryable } from "./types.js";

/** The parts of a pg Pool this library uses. */
interface PoolLike extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
}

/** Wraps a `pg` Pool so each transaction runs on one pooled connection. */
export function fromPgPool(pool: PoolLike): Database {
  return {
    query: (sql, params) => pool.query(sql, params),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn(client);
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

/** The table definition from sql/idempotency_keys.sql. */
export const SCHEMA = readFileSync(new URL("../sql/idempotency_keys.sql", import.meta.url), "utf8");

/** Creates the idempotency_keys table if it is missing. */
export async function migrate(db: Queryable): Promise<void> {
  for (const statement of SCHEMA.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) await db.query(statement);
}
