import { PGlite } from "@electric-sql/pglite";
import { migrate, run } from "../src/index.js";
import type { Database, Handler, Hooks, IdempotentRequest, Outcome, Queryable, StoredResponse } from "../src/types.js";

export const LEASE_MS = 30_000;

export class FakeClock {
  private time = Date.parse("2026-01-01T00:00:00Z");
  now = () => new Date(this.time);
  advance(ms: number) {
    this.time += ms;
  }
}

export type Charge = {
  id: string;
  amount: number;
  status: "succeeded" | "declined";
};

/**
 * A payment processor that, like Stripe, honours idempotency keys: a
 * repeated key returns the original charge instead of charging again.
 * It lives outside the database, so a rolled-back transaction cannot undo it.
 */
export class FakeProcessor {
  readonly charges = new Map<string, Charge>();
  calls = 0;
  /** Make the next call fail: before charging, or after charging with the reply lost. */
  failNext: "before" | "after" | null = null;

  async charge(amount: number, idempotencyKey: string): Promise<Charge> {
    this.calls++;
    const failure = this.failNext;
    this.failNext = null;
    if (failure === "before") throw new Error("network error before the charge");
    let charge = this.charges.get(idempotencyKey);
    if (!charge) {
      charge = { id: `ch_${this.charges.size + 1}`, amount, status: amount > 10_000 ? "declined" : "succeeded" };
      this.charges.set(idempotencyKey, charge);
    }
    if (failure === "after") throw new Error("timeout: the charge went through but the reply was lost");
    return charge;
  }
}

export const ORDERS = `create table orders (
  id bigserial primary key,
  customer text not null,
  amount integer not null,
  status text not null default 'pending',
  charge_id text
)`;

export async function createDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await migrate(db);
  await db.query(ORDERS);
  return db;
}

export async function reset(db: Queryable) {
  await db.query("truncate idempotency_keys, orders restart identity");
}

/** POST /orders: create the order, charge it, mark it paid or declined. */
export function createOrder(processor: FakeProcessor, customer: string, amount: number): Handler {
  return async (flow): Promise<StoredResponse> => {
    const order = await flow.atomic("order_created", async (tx) => {
      const { rows } = await tx.query<{ id: string }>("insert into orders (customer, amount) values ($1, $2) returning id::text as id", [customer, amount]);
      return { orderId: rows[0]!.id };
    });

    const charge = await flow.external("charge_created", (downstreamKey) => processor.charge(amount, downstreamKey));

    if (charge.status === "declined") {
      await flow.atomic("order_declined", async (tx) => {
        await tx.query("update orders set status = 'declined', charge_id = $2 where id = $1::bigint", [order.orderId, charge.id]);
      });
      return { status: 402, body: { error: { type: "card_error", message: "The card was declined." }, orderId: order.orderId } };
    }

    await flow.atomic("order_paid", async (tx) => {
      await tx.query("update orders set status = 'paid', charge_id = $2 where id = $1::bigint", [order.orderId, charge.id]);
    });
    return { status: 201, body: { orderId: order.orderId, chargeId: charge.id, status: "paid" } };
  };
}

export function orderRequest(amount = 2_500, key: string | null = "key_1", scope = "acct_1"): IdempotentRequest {
  return { scope, key, method: "POST", path: "/orders", params: { customer: "cus_1", amount } };
}

export function attempt(db: Database, clock: FakeClock, processor: FakeProcessor, request: IdempotentRequest, hooks?: Hooks): Promise<Outcome> {
  const params = request.params as { customer: string; amount: number };
  return run({ db, leaseMs: LEASE_MS, now: clock.now, hooks }, request, createOrder(processor, params.customer, params.amount));
}

export async function orders(db: Queryable) {
  const { rows } = await db.query<{ id: string; status: string; charge_id: string | null }>("select id::text as id, status, charge_id from orders order by id");
  return rows;
}
