import { createHash, randomUUID } from "node:crypto";
import { isSimulatedCrash } from "./testing.js";
import type { Flow, Handler, IdempotentRequest, Json, Options, Outcome, Queryable } from "./types.js";

const MAX_KEY_LENGTH = 255;

interface KeyRow {
  id: string;
  request_hash: string;
  locked_by: string | null;
  locked_until: Date | null;
  phases: Record<string, Json>;
  response_status: number | null;
  response_body: Json;
}

/** Thrown inside an attempt when another attempt has taken its lease. */
class LeaseLost extends Error {}

/** JSON with sorted keys, so the same body always hashes the same. */
function stable(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k] as Json)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The value as JSON would carry it, so a first run returns what a retry reads back. */
const toJson = (value: unknown): Json => JSON.parse(JSON.stringify(value ?? null)) as Json;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function requestHash(request: Pick<IdempotentRequest, "method" | "path" | "params">): string {
  return sha256(stable({ method: request.method.toUpperCase(), path: request.path, params: request.params }));
}

/** The key handed to another system for one phase. Stable across retries, at most 64 characters. */
export function downstreamKey(scope: string, key: string, phase: string): string {
  return `idem_${sha256(stable([scope, key, phase])).slice(0, 59)}`;
}

/**
 * Runs `handler` at most once per (scope, key), across retries, crashes and
 * concurrent attempts.
 *
 *   1. Claim the key with a lease, or report it in progress, finished
 *      (replay) or reused with a different request (mismatch).
 *   2. Run the handler. Each phase it completes is recorded; on a retry
 *      completed phases are skipped and return their recorded result.
 *   3. Store the response and release the key.
 *
 * Every write after the claim checks the lease token, so an attempt that
 * stalled until another took over can no longer change anything.
 */
export async function run(options: Options, request: IdempotentRequest, handler: Handler): Promise<Outcome> {
  const { db, hooks } = options;
  const leaseMs = options.leaseMs ?? 30_000;
  const now = options.now ?? (() => new Date());
  const point = async (name: string) => hooks?.point?.(name);
  const leaseUntil = () => new Date(now().getTime() + leaseMs).toISOString();

  if (request.key === null || request.key === undefined || request.key === "") return { kind: "missing_key" };
  if (request.key.length > MAX_KEY_LENGTH) return { kind: "invalid_key" };
  const key = request.key;
  const hash = requestHash(request);
  const token = randomUUID();

  // 1. Claim.
  const claim = await db.transaction<{ outcome: Outcome } | { row: KeyRow }>(async (tx) => {
    await tx.query("insert into idempotency_keys (scope, key, request_hash, created_at) values ($1, $2, $3, $4) on conflict (scope, key) do nothing", [
      request.scope,
      key,
      hash,
      now().toISOString(),
    ]);
    const { rows } = await tx.query<KeyRow>(
      `select id::text as id, request_hash, locked_by, locked_until, phases, response_status, response_body
       from idempotency_keys where scope = $1 and key = $2 for update`,
      [request.scope, key],
    );
    const row = rows[0]!;
    if (row.request_hash !== hash) return { outcome: { kind: "mismatch" } };
    if (row.response_status !== null) return { outcome: { kind: "replayed", response: { status: row.response_status, body: row.response_body } } };
    if (row.locked_until !== null && new Date(row.locked_until).getTime() > now().getTime()) {
      const seconds = Math.max(1, Math.ceil((new Date(row.locked_until).getTime() - now().getTime()) / 1000));
      return { outcome: { kind: "in_progress", retryAfterSeconds: seconds } };
    }
    await tx.query("update idempotency_keys set locked_by = $2, locked_until = $3 where id = $1::bigint", [row.id, token, leaseUntil()]);
    await point("claim:before-commit");
    return { row };
  });
  if ("outcome" in claim) return claim.outcome;
  await point("claim:after-commit");

  const id = claim.row.id;
  const phases: Record<string, Json> = { ...claim.row.phases };

  /** Locks the key row and checks this attempt still holds it. */
  const fence = async (tx: Queryable) => {
    const { rows } = await tx.query<{ locked_by: string | null }>("select locked_by from idempotency_keys where id = $1::bigint for update", [id]);
    if (rows[0]?.locked_by !== token) throw new LeaseLost();
  };

  const record = async (tx: Queryable, name: string, result: Json) => {
    await tx.query(
      "update idempotency_keys set phases = phases || jsonb_build_object($2::text, $3::jsonb), recovery_point = $2, locked_until = $4 where id = $1::bigint",
      [id, name, JSON.stringify(result), leaseUntil()],
    );
    phases[name] = result;
  };

  const flow: Flow = {
    async atomic(name, fn) {
      if (name in phases) return phases[name] as never;
      await point(`atomic:${name}:before`);
      const result = await db.transaction(async (tx) => {
        await fence(tx);
        const value = toJson(await fn(tx));
        await record(tx, name, value);
        await point(`atomic:${name}:before-commit`);
        return value;
      });
      await point(`atomic:${name}:after-commit`);
      return result as never;
    },

    async external(name, fn) {
      if (name in phases) return phases[name] as never;
      // Not a guarantee (the lease can be lost during the call), only a way
      // to skip a call that would certainly be thrown away.
      await db.transaction(fence);
      await point(`external:${name}:before-call`);
      const value = toJson(await fn(downstreamKey(request.scope, key, name)));
      await point(`external:${name}:after-call`);
      await db.transaction(async (tx) => {
        await fence(tx);
        await record(tx, name, value);
        await point(`external:${name}:before-commit`);
      });
      await point(`external:${name}:after-commit`);
      return value as never;
    },
  };

  // 2 and 3. Run, then store the response and release the key.
  try {
    const result = await handler(flow);
    const response = { status: result.status, body: toJson(result.body) };
    await db.transaction(async (tx) => {
      await fence(tx);
      await tx.query(
        `update idempotency_keys set response_status = $2, response_body = $3::json, completed_at = $4,
           recovery_point = 'finished', locked_by = null, locked_until = null
         where id = $1::bigint`,
        [id, response.status, JSON.stringify(response.body), now().toISOString()],
      );
      await point("complete:before-commit");
    });
    await point("complete:after-commit");
    return { kind: "executed", response };
  } catch (error) {
    if (error instanceof LeaseLost) return { kind: "lease_lost" };
    // A dead process runs no cleanup; its lease simply runs out.
    if (isSimulatedCrash(error)) throw error;
    // An unexpected error: let the next attempt resume straight away from
    // the last completed phase.
    await db.query("update idempotency_keys set locked_by = null, locked_until = null where id = $1::bigint and locked_by = $2", [id, token]);
    throw error;
  }
}

/** Deletes keys created before `before` that are finished or abandoned. Stripe keeps keys for 24 hours. */
export async function deleteExpired(db: Queryable, before: Date, now: Date = new Date()): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `delete from idempotency_keys
     where created_at < $1 and (completed_at is not null or locked_until is null or locked_until < $2)
     returning id::text as id`,
    [before.toISOString(), now.toISOString()],
  );
  return rows.length;
}

