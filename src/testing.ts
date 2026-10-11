import type { Hooks, Outcome } from "./types.js";

const CRASH = Symbol.for("idempotency-keys.simulated-crash");

/**
 * Thrown by a hook to stand in for the process dying at that point. Inside
 * a transaction it rolls the transaction back, as a lost connection would;
 * outside one, the library runs none of its cleanup.
 */
export class SimulatedCrash extends Error {
  readonly [CRASH] = true;
  constructor(readonly point: string) {
    super(`simulated crash at ${point}`);
  }
}

export const isSimulatedCrash = (error: unknown): error is SimulatedCrash =>
  typeof error === "object" && error !== null && (error as Record<symbol, unknown>)[CRASH] === true;

/** Hooks that record every point an attempt passes. */
export function recordPoints(): { points: string[]; hooks: Hooks } {
  const points: string[] = [];
  return { points, hooks: { point: (name) => void points.push(name) } };
}

/** Hooks that crash at the nth point (1-based). */
export function crashAt(n: number): { points: string[]; hooks: Hooks } {
  const points: string[] = [];
  return {
    points,
    hooks: {
      point(name) {
        points.push(name);
        if (points.length === n) throw new SimulatedCrash(name);
      },
    },
  };
}

type Finished = Extract<Outcome, { kind: "executed" | "replayed" }>;

export interface CrashTestOptions {
  /** Empty the tables the handler writes to, and the keys. Called before each scenario. */
  reset(): Promise<void>;
  /** One attempt at the request, with the given hooks and the same key every time. */
  attempt(hooks?: Hooks): Promise<Outcome>;
  /** Move the clock past the lease, as a client retrying later would see. */
  expireLease(): void;
  /** Your invariants, checked after the request has finally succeeded. */
  check(result: { response: Finished["response"]; crashedAt: string | null }): Promise<void>;
}

/**
 * Runs the request once cleanly to list every crash point, then once per
 * point: crash there, retry until it succeeds, retry once more to see the
 * replay. Returns the points it exercised.
 */
export async function testEveryCrashPoint(options: CrashTestOptions): Promise<string[]> {
  await options.reset();
  const clean = recordPoints();
  const first = await options.attempt(clean.hooks);
  if (first.kind !== "executed") throw new Error(`the clean run returned ${first.kind}`);
  await options.check({ response: first.response, crashedAt: null });

  for (let n = 1; n <= clean.points.length; n++) {
    await options.reset();
    const crash = crashAt(n);
    const crashedAt = clean.points[n - 1]!;
    await options.attempt(crash.hooks).then(
      (outcome) => {
        throw new Error(`expected a crash at ${crashedAt}, got ${outcome.kind}`);
      },
      (error: unknown) => {
        if (!isSimulatedCrash(error)) throw error;
      },
    );

    // An immediate retry is told to wait while the dead attempt's lease
    // lasts. It can run at once only if the claim itself never committed,
    // and it replays if the crash came after the response was stored.
    let result = await options.attempt();
    if (result.kind === "in_progress") {
      options.expireLease();
      result = await options.attempt();
    }
    if (result.kind !== "executed" && result.kind !== "replayed") throw new Error(`after a crash at ${crashedAt}, the retry returned ${result.kind}`);

    const replay = await options.attempt();
    if (replay.kind !== "replayed") throw new Error(`after a crash at ${crashedAt}, a further retry returned ${replay.kind}`);
    if (JSON.stringify(replay.response) !== JSON.stringify(result.response)) throw new Error(`after a crash at ${crashedAt}, the replay differs`);
    await options.check({ response: result.response, crashedAt });
  }
  return clean.points;
}
