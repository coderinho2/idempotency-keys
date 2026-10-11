import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toHttp } from "../src/index.js";
import { attempt, createDatabase, FakeClock, FakeProcessor, LEASE_MS, orderRequest, orders, reset } from "./fixtures.js";

let db: PGlite;
let clock: FakeClock;
let processor: FakeProcessor;

beforeAll(async () => {
  db = await createDatabase();
});
beforeEach(async () => {
  await reset(db);
  clock = new FakeClock();
  processor = new FakeProcessor();
});

/** Starts an attempt that freezes at `pointName` (a long GC pause, a stuck network call) until released. */
function frozenAttempt(pointName: string) {
  let release!: () => void;
  const frozen = new Promise<void>((resolve) => (release = resolve));
  const outcome = attempt(db, clock, processor, orderRequest(), { point: (name) => (name === pointName ? frozen : undefined) });
  return { outcome, release };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("an attempt that stalls past its lease", () => {
  it("cannot record its charge after another attempt has taken over and finished", async () => {
    const zombie = frozenAttempt("external:charge_created:before-call");
    await tick();

    clock.advance(LEASE_MS + 1);
    const takeover = await attempt(db, clock, processor, orderRequest());
    expect(takeover).toMatchObject({ kind: "executed", response: { status: 201 } });

    // The zombie wakes and calls the processor with the same downstream key.
    zombie.release();
    const late = await zombie.outcome;
    expect(late.kind).toBe("lease_lost");
    expect(toHttp(late).status).toBe(409);

    expect(processor.calls).toBe(2);
    expect(processor.charges.size).toBe(1);
    expect(await orders(db)).toMatchObject([{ status: "paid", charge_id: "ch_1" }]);
    expect(await attempt(db, clock, processor, orderRequest())).toEqual({ kind: "replayed", response: takeover.kind === "executed" ? takeover.response : null });
  });

  it("cannot write its own phase either", async () => {
    const zombie = frozenAttempt("atomic:order_created:before");
    await tick();

    clock.advance(LEASE_MS + 1);
    expect((await attempt(db, clock, processor, orderRequest())).kind).toBe("executed");

    zombie.release();
    expect((await zombie.outcome).kind).toBe("lease_lost");
    expect(await orders(db)).toHaveLength(1);
  });

  it("keeps its lease while it makes progress, however long the whole request takes", async () => {
    // Each finished phase extends the lease, so only a stall longer than
    // the lease lets another attempt in.
    const competitors: string[] = [];
    const slow = attempt(db, clock, processor, orderRequest(), {
      async point(name) {
        if (name.endsWith(":after-commit") && name !== "complete:after-commit") {
          clock.advance(LEASE_MS - 1_000);
          competitors.push((await attempt(db, clock, processor, orderRequest())).kind);
        }
      },
    });
    expect((await slow).kind).toBe("executed");
    // Four phases took almost four leases in all, and nobody got in.
    expect(competitors).toEqual(["in_progress", "in_progress", "in_progress", "in_progress"]);
  });
});

describe("many identical requests at once", () => {
  it("run the handler once; the others wait or replay", async () => {
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => attempt(db, clock, processor, orderRequest())));
    const kinds = outcomes.map((o) => o.kind);
    expect(kinds.filter((k) => k === "executed")).toHaveLength(1);
    expect(kinds.every((k) => k === "executed" || k === "in_progress" || k === "replayed")).toBe(true);
    expect(await orders(db)).toHaveLength(1);
    expect(processor.charges.size).toBe(1);
  });
});
