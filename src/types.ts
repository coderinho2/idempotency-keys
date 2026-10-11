/** Anything that runs SQL. A pg PoolClient, a PGlite instance or transaction all fit. */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** A database that can run a callback inside one transaction. PGlite fits as is; see `fromPgPool` for pg. */
export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface IdempotentRequest {
  /** Who the key belongs to, usually the authenticated account. Keys never collide across scopes. */
  scope: string;
  /** The client's Idempotency-Key header. */
  key: string | null | undefined;
  method: string;
  path: string;
  /** The parsed request body. A key reused with different params is refused. */
  params: Json;
}

export interface StoredResponse {
  status: number;
  body: Json;
}

export type Outcome =
  /** This attempt ran the handler to the end. */
  | { kind: "executed"; response: StoredResponse }
  /** An earlier attempt finished; this is its response. */
  | { kind: "replayed"; response: StoredResponse }
  /** Another attempt holds the key right now. */
  | { kind: "in_progress"; retryAfterSeconds: number }
  /** This attempt's lease was taken over after it expired; its work is the new owner's now. */
  | { kind: "lease_lost" }
  /** The key was used before with a different method, path or body. */
  | { kind: "mismatch" }
  | { kind: "missing_key" }
  | { kind: "invalid_key" };

/**
 * Named points in a request where a process can die. A hook that throws a
 * SimulatedCrash at one of them leaves the database exactly as a real
 * crash would; see `testing`.
 */
export interface Hooks {
  point?(name: string): void | Promise<void>;
}

export interface Options {
  db: Database;
  /** How long an attempt may hold a key without making progress. Default 30 s. */
  leaseMs?: number;
  /** Injected so tests can move time. Default `() => new Date()`. */
  now?: () => Date;
  hooks?: Hooks;
}

export interface Flow {
  /**
   * Runs `fn` in a transaction that also records the phase as done, so its
   * writes happen exactly once. On a retry the phase is skipped and its
   * recorded result returned. The result must be JSON-serialisable.
   */
  atomic<T>(name: string, fn: (tx: Queryable) => Promise<T>): Promise<Jsonified<T>>;
  /**
   * Calls another system. `fn` gets a key derived from this request and the
   * phase name; pass it on (for example as Stripe's idempotencyKey) so a
   * retried call cannot act twice. The result is recorded once it returns.
   */
  external<T>(name: string, fn: (downstreamKey: string) => Promise<T>): Promise<Jsonified<T>>;
}

/** What a handler returns. The body must be JSON-serialisable; it is stored as JSON. */
export interface HandlerResponse {
  status: number;
  body: unknown;
}

export type Handler = (flow: Flow) => Promise<HandlerResponse>;

/**
 * A phase result as it comes back from JSON: what the first attempt returns
 * and what a retry reads back are the same value.
 */
export type Jsonified<T> = T extends void | undefined ? null : T extends Date ? string : T extends (infer U)[] ? Jsonified<U>[] : T extends object ? { [K in keyof T]: Jsonified<T[K]> } : T;
