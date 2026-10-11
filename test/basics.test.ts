import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deleteExpired, downstreamKey, run, toHttp } from "../src/index.js";
import { attempt, createDatabase, FakeClock, FakeProcessor, orderRequest, orders, reset } from "./fixtures.js";

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

describe("a request with an idempotency key", () => {
  it("runs once, then replays the same response with Idempotent-Replayed", async () => {
    const first = await attempt(db, clock, processor, orderRequest());
    expect(first).toEqual({ kind: "executed", response: { status: 201, body: { orderId: "1", chargeId: "ch_1", status: "paid" } } });

    const second = await attempt(db, clock, processor, orderRequest());
    expect(toHttp(second)).toEqual({ status: 201, headers: { "Idempotent-Replayed": "true" }, body: { orderId: "1", chargeId: "ch_1", status: "paid" } });
    expect(await orders(db)).toHaveLength(1);
    expect(processor.calls).toBe(1);
  });

  it("stores a declined payment too, so a retry does not charge again", async () => {
    const first = await attempt(db, clock, processor, orderRequest(50_000));
    expect(toHttp(first).status).toBe(402);
    expect(await attempt(db, clock, processor, orderRequest(50_000))).toMatchObject({ kind: "replayed", response: { status: 402 } });
    expect(processor.calls).toBe(1);
    expect(await orders(db)).toMatchObject([{ status: "declined", charge_id: "ch_1" }]);
  });

  it("refuses the same key for a different request with 422", async () => {
    await attempt(db, clock, processor, orderRequest(2_500));
    const reused = await attempt(db, clock, processor, orderRequest(9_900));
    expect(toHttp(reused)).toMatchObject({ status: 422, body: { error: { type: "idempotency_error" } } });
  });

  it("treats the body's key order as irrelevant", async () => {
    await attempt(db, clock, processor, orderRequest());
    const reordered = { ...orderRequest(), params: { amount: 2_500, customer: "cus_1" } };
    expect((await attempt(db, clock, processor, reordered)).kind).toBe("replayed");
  });

  it("keeps keys apart by scope", async () => {
    await attempt(db, clock, processor, orderRequest(2_500, "key_1", "acct_1"));
    expect((await attempt(db, clock, processor, orderRequest(2_500, "key_1", "acct_2"))).kind).toBe("executed");
    expect(await orders(db)).toHaveLength(2);
  });

  it("asks for a key when there is none, or it is too long", async () => {
    expect(toHttp(await attempt(db, clock, processor, orderRequest(2_500, null))).status).toBe(400);
    expect(toHttp(await attempt(db, clock, processor, orderRequest(2_500, "x".repeat(256)))).status).toBe(400);
    expect(await orders(db)).toHaveLength(0);
  });
});

describe("while an attempt holds the key", () => {
  it("tells a concurrent attempt to retry later with 409 and Retry-After", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = attempt(db, clock, processor, orderRequest(), {
      point: (name) => (name === "external:charge_created:before-call" ? held : undefined),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    clock.advance(10_000);

    const second = await attempt(db, clock, processor, orderRequest());
    expect(toHttp(second)).toMatchObject({ status: 409, headers: { "Retry-After": "20" } });

    release();
    expect((await first).kind).toBe("executed");
  });
});

describe("when the handler fails", () => {
  it("releases the key so an immediate retry resumes after the last finished phase", async () => {
    processor.failNext = "before";
    await expect(attempt(db, clock, processor, orderRequest())).rejects.toThrow("network error");

    const retry = await attempt(db, clock, processor, orderRequest());
    expect(retry.kind).toBe("executed");
    // The order was not created twice: the first phase was skipped.
    expect(await orders(db)).toMatchObject([{ id: "1", status: "paid" }]);
  });

  it("does not charge twice when the processor charged but the reply was lost", async () => {
    processor.failNext = "after";
    await expect(attempt(db, clock, processor, orderRequest())).rejects.toThrow("timeout");

    expect((await attempt(db, clock, processor, orderRequest())).kind).toBe("executed");
    expect(processor.calls).toBe(2);
    expect(processor.charges.size).toBe(1);
    expect(await orders(db)).toMatchObject([{ status: "paid", charge_id: "ch_1" }]);
  });
});

describe("downstream keys", () => {
  it("are stable, distinct per phase and scope, and short enough for Stripe", () => {
    const key = downstreamKey("acct_1", "key_1", "charge_created");
    expect(key).toBe(downstreamKey("acct_1", "key_1", "charge_created"));
    expect(key).not.toBe(downstreamKey("acct_2", "key_1", "charge_created"));
    expect(key).not.toBe(downstreamKey("acct_1", "key_1", "refund_created"));
    expect(key.length).toBeLessThanOrEqual(64);
  });
});

describe("deleteExpired", () => {
  it("removes old finished keys and abandoned ones, never a key that is running", async () => {
    await attempt(db, clock, processor, orderRequest(2_500, "done"));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const running = run(
      { db, leaseMs: 48 * 3_600_000, now: clock.now, hooks: { point: (name) => (name === "claim:after-commit" ? held : undefined) } },
      orderRequest(2_500, "running"),
      async () => ({ status: 200, body: null }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    clock.advance(25 * 3_600_000);
    const deleted = await deleteExpired(db, new Date(clock.now().getTime() - 24 * 3_600_000), clock.now());
    expect(deleted).toBe(1);
    const { rows } = await db.query<{ key: string }>("select key from idempotency_keys");
    expect(rows.map((r) => r.key)).toEqual(["running"]);
    release();
    await running;
  });
});
