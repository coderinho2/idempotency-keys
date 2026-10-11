import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { testEveryCrashPoint } from "../src/index.js";
import { attempt, createDatabase, FakeClock, FakeProcessor, LEASE_MS, orderRequest, orders, reset } from "./fixtures.js";

let db: PGlite;
beforeAll(async () => {
  db = await createDatabase();
});

describe("a crash at any point", () => {
  it("still creates one order and one charge, and every retry gets the same answer (paid)", async () => {
    let clock = new FakeClock();
    let processor = new FakeProcessor();
    const points = await testEveryCrashPoint({
      async reset() {
        await reset(db);
        clock = new FakeClock();
        processor = new FakeProcessor();
      },
      attempt: (hooks) => attempt(db, clock, processor, orderRequest(), hooks),
      expireLease: () => clock.advance(LEASE_MS + 1),
      async check({ response, crashedAt }) {
        const rows = await orders(db);
        expect(rows, `crash at ${crashedAt}`).toEqual([{ id: rows[0]!.id, status: "paid", charge_id: "ch_1" }]);
        expect(processor.charges.size, `crash at ${crashedAt}`).toBe(1);
        expect(response, `crash at ${crashedAt}`).toEqual({ status: 201, body: { orderId: rows[0]!.id, chargeId: "ch_1", status: "paid" } });
      },
    });

    expect(points).toEqual([
      "claim:before-commit",
      "claim:after-commit",
      "atomic:order_created:before",
      "atomic:order_created:before-commit",
      "atomic:order_created:after-commit",
      "external:charge_created:before-call",
      "external:charge_created:after-call",
      "external:charge_created:before-commit",
      "external:charge_created:after-commit",
      "atomic:order_paid:before",
      "atomic:order_paid:before-commit",
      "atomic:order_paid:after-commit",
      "complete:before-commit",
      "complete:after-commit",
    ]);
  });

  it("still records one declined order and one declined charge (402)", async () => {
    let clock = new FakeClock();
    let processor = new FakeProcessor();
    const points = await testEveryCrashPoint({
      async reset() {
        await reset(db);
        clock = new FakeClock();
        processor = new FakeProcessor();
      },
      attempt: (hooks) => attempt(db, clock, processor, orderRequest(50_000), hooks),
      expireLease: () => clock.advance(LEASE_MS + 1),
      async check({ response, crashedAt }) {
        expect(await orders(db), `crash at ${crashedAt}`).toMatchObject([{ status: "declined", charge_id: "ch_1" }]);
        expect(processor.charges.size).toBe(1);
        expect(response.status).toBe(402);
      },
    });
    expect(points).toContain("atomic:order_declined:before-commit");
  });
});
