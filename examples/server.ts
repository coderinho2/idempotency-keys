// POST /orders on a plain Node server: create an order, take the payment
// with Stripe, mark the order paid. A client can retry as often as it
// likes with the same Idempotency-Key; the customer is charged once.
//
// It is type-checked in CI; to run it, compile it with tsc or use tsx.
import http from "node:http";
import pg from "pg";
import Stripe from "stripe";
import { fromPgPool, migrate, run, toHttp } from "../src/index.js";
import type { Handler, Json } from "../src/index.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "");
const db = fromPgPool(new pg.Pool({ connectionString: process.env.DATABASE_URL }));

function createOrder(customer: string, amount: number): Handler {
  return async (flow) => {
    const order = await flow.atomic("order_created", async (tx) => {
      const { rows } = await tx.query<{ id: string }>("insert into orders (customer, amount) values ($1, $2) returning id::text as id", [customer, amount]);
      return { orderId: rows[0]!.id };
    });

    // Stripe keeps its own idempotency keys for 24 hours, so a retried call
    // with the same key returns the first PaymentIntent (or the same error).
    const payment = await flow.external("payment_created", async (idempotencyKey) => {
      try {
        const intent = await stripe.paymentIntents.create(
          { amount, currency: "usd", customer, payment_method: "pm_card_visa", confirm: true, automatic_payment_methods: { enabled: true, allow_redirects: "never" } },
          { idempotencyKey },
        );
        return { id: intent.id, status: intent.status as string, message: null };
      } catch (error) {
        // A decline is an answer, not a failure: record it so it is replayed.
        if (error instanceof Stripe.errors.StripeCardError) return { id: null, status: "declined", message: error.message };
        throw error;
      }
    });

    await flow.atomic("order_updated", async (tx) => {
      await tx.query("update orders set status = $2, payment_intent = $3 where id = $1::bigint", [order.orderId, payment.status, payment.id]);
    });
    if (payment.status === "declined") return { status: 402, body: { error: { type: "card_error", message: payment.message } } };
    return { status: 201, body: { orderId: order.orderId, paymentIntent: payment.id, status: payment.status } };
  };
}

const server = http.createServer(async (req, res) => {
  const send = (status: number, headers: Record<string, string>, body: Json) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(body));
  };
  if (req.method !== "POST" || req.url !== "/orders") return send(404, {}, { error: { message: "Not found" } });

  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const params = JSON.parse(raw || "{}") as { customer: string; amount: number };
    // In a real app the scope is the authenticated account, never a header the client controls.
    const scope = String(req.headers["x-account-id"] ?? "anonymous");
    const key = req.headers["idempotency-key"];

    const outcome = await run({ db }, { scope, key: Array.isArray(key) ? key[0] : key, method: "POST", path: "/orders", params }, createOrder(params.customer, params.amount));
    const response = toHttp(outcome);
    send(response.status, response.headers, response.body);
  } catch {
    // Not stored: the client's retry resumes after the last finished phase.
    send(500, {}, { error: { type: "api_error", message: "Something went wrong. Retry with the same Idempotency-Key." } });
  }
});

await migrate(db);
await db.query("create table if not exists orders (id bigserial primary key, customer text not null, amount integer not null, status text not null default 'pending', payment_intent text)");
server.listen(3000, () => console.log("listening on http://localhost:3000"));
