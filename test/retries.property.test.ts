import type { PGlite } from "@electric-sql/pglite";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { crashAt, isSimulatedCrash } from "../src/index.js";
import type { Hooks, StoredResponse } from "../src/types.js";
import { attempt, createDatabase, FakeClock, FakeProcessor, LEASE_MS, orderRequest, orders, reset } from "./fixtures.js";

let db: PGlite;
beforeAll(async () => {
  db = await createDatabase();
});

/** One client retry: some time passes, then the attempt may die or the processor may fail. */
const step = fc.record({
  wait: fc.constantFrom(0, 1_000, LEASE_MS / 2, LEASE_MS + 1),
  fault: fc.oneof(
    fc.constant({ kind: "none" as const }),
    fc.integer({ min: 1, max: 16 }).map((n) => ({ kind: "crash" as const, n })),
    fc.constantFrom("before", "after").map((when) => ({ kind: "processor" as const, when: when as "before" | "after" })),
  ),
});

const RUNS = Number(process.env.PROPERTY_RUNS ?? 300);

describe("any sequence of retries, crashes and processor failures", () => {
  it("creates at most one order and one charge, never gives two different answers, and finishes once the faults stop", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.array(step, { maxLength: 12 }), async (declined, steps) => {
        await reset(db);
        const clock = new FakeClock();
        const processor = new FakeProcessor();
        const request = orderRequest(declined ? 50_000 : 2_500);
        const answers: StoredResponse[] = [];

        const check = async () => {
          expect((await orders(db)).length).toBeLessThanOrEqual(1);
          expect(processor.charges.size).toBeLessThanOrEqual(1);
          for (const answer of answers) expect(JSON.stringify(answer)).toBe(JSON.stringify(answers[0]));
        };

        for (const { wait, fault } of steps) {
          clock.advance(wait);
          let hooks: Hooks | undefined;
          if (fault.kind === "crash") hooks = crashAt(fault.n).hooks;
          if (fault.kind === "processor") processor.failNext = fault.when;
          try {
            const outcome = await attempt(db, clock, processor, request, hooks);
            if (outcome.kind === "executed" || outcome.kind === "replayed") answers.push(outcome.response);
            else expect(outcome.kind).toBe("in_progress");
          } catch (error) {
            if (!isSimulatedCrash(error) && !String(error).match(/network error|timeout/)) throw error;
          }
          processor.failNext = null;
          await check();
        }

        // The faults stop; the client retries once the last lease is over.
        clock.advance(LEASE_MS + 1);
        const final = await attempt(db, clock, processor, request);
        if (final.kind !== "executed" && final.kind !== "replayed") throw new Error(`final attempt returned ${final.kind}`);
        answers.push(final.response);
        await check();

        const rows = await orders(db);
        expect(rows).toMatchObject([{ status: declined ? "declined" : "paid", charge_id: "ch_1" }]);
        expect(final.response.status).toBe(declined ? 402 : 201);
      }),
      { numRuns: RUNS },
    );
  }, 300_000);
});
