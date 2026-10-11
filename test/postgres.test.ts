// The same guarantees on a real Postgres server, with real concurrent
// connections and row locks. Runs when DATABASE_URL is set (CI provides one).
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fromPgPool, migrate, testEveryCrashPoint } from "../src/index.js";
import type { Database } from "../src/types.js";
import { attempt, FakeClock, FakeProcessor, LEASE_MS, ORDERS, orderRequest, orders, reset } from "./fixtures.js";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("on a real Postgres server", () => {
  let pool: pg.Pool;
  let db: Database;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 25 });
    db = fromPgPool(pool);
    await db.query("drop table if exists idempotency_keys, orders");
    await migrate(db);
    await db.query(ORDERS);
  });
  afterAll(async () => pool?.end());
  beforeEach(async () => reset(db));

  it("runs the handler once when 50 identical requests arrive together", async () => {
    const clock = new FakeClock();
    const processor = new FakeProcessor();
    const outcomes = await Promise.all(Array.from({ length: 50 }, () => attempt(db, clock, processor, orderRequest())));
    const kinds = outcomes.map((o) => o.kind);
    expect(kinds.filter((k) => k === "executed")).toHaveLength(1);
    expect(kinds.every((k) => k === "executed" || k === "in_progress" || k === "replayed")).toBe(true);
    expect(await orders(db)).toHaveLength(1);
    expect(processor.charges.size).toBe(1);
  });

  it("runs 50 different keys in parallel without interference", async () => {
    const clock = new FakeClock();
    const processor = new FakeProcessor();
    const outcomes = await Promise.all(Array.from({ length: 50 }, (_, i) => attempt(db, clock, processor, orderRequest(2_500, `key_${i}`))));
    expect(outcomes.every((o) => o.kind === "executed")).toBe(true);
    expect(await orders(db)).toHaveLength(50);
    expect(processor.charges.size).toBe(50);
  });

  it("survives a crash at every point", async () => {
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
      async check({ crashedAt }) {
        expect(await orders(db), `crash at ${crashedAt}`).toMatchObject([{ status: "paid", charge_id: "ch_1" }]);
        expect(processor.charges.size).toBe(1);
      },
    });
    expect(points).toHaveLength(14);
  });
});
