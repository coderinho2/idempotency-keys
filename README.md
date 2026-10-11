# idempotency-keys

[![test](https://github.com/coderinho2/idempotency-keys/actions/workflows/test.yml/badge.svg)](https://github.com/coderinho2/idempotency-keys/actions/workflows/test.yml)

Stripe-style idempotency keys for your own API, stored in Postgres.

A request can be retried, crash partway through, or arrive twice at the
same moment. Its work still happens once, and every retry gets the same
answer. A test harness proves this by crashing a request at every point
it can die, then retrying it.

## The bug this prevents

A client sends `POST /orders`. Your server creates the order, charges the
card, and then the connection drops before the response gets back. The
client retries, as it should. Without idempotency the customer now has two
orders and two charges.

An idempotency key alone isn't enough. The usual "check the key, then do
the work" has gaps:

- The server can crash halfway, after the charge but before saving that it
  happened.
- Two retries can run at the same time.
- A request can stall in a long garbage-collection pause or a hung network
  call, then wake up after a retry has already finished the job.

This library closes all three.

## Use it

```ts
import { fromPgPool, migrate, run, toHttp } from "idempotency-keys";

const db = fromPgPool(new pg.Pool());
await migrate(db); // creates the idempotency_keys table

const outcome = await run(
  { db },
  { scope: accountId, key: req.headers["idempotency-key"], method: "POST", path: "/orders", params: body },
  async (flow) => {
    const order = await flow.atomic("order_created", (tx) =>
      tx.query("insert into orders (customer, amount) values ($1, $2) returning id", [body.customer, body.amount]).then((r) => r.rows[0]),
    );
    const payment = await flow.external("payment_created", (idempotencyKey) =>
      stripe.paymentIntents.create({ amount: body.amount, currency: "usd", /* ... */ }, { idempotencyKey }),
    );
    await flow.atomic("order_paid", (tx) => tx.query("update orders set status = 'paid' where id = $1", [order.id]));
    return { status: 201, body: { orderId: order.id, paymentIntent: payment.id } };
  },
);

const { status, headers, body: responseBody } = toHttp(outcome);
```

A runnable server is in [examples/server.ts](examples/server.ts).

The handler is a series of named **phases**:

- `flow.atomic(name, fn)` runs `fn` in a transaction. The same transaction
  records that the phase is done, so its writes happen exactly once.
- `flow.external(name, fn)` calls another system. `fn` receives a key
  derived from this request and the phase name. Pass it on, as above with
  Stripe, and a repeated call can't act twice.

On a retry, finished phases are skipped and their recorded results are
returned. The request picks up where the last attempt stopped.

### What clients see

| Situation | Response |
| --- | --- |
| First time | Your handler's response |
| Already finished | The same response, byte for byte, with `Idempotent-Replayed: true` |
| Another attempt holds the key | `409` with `Retry-After` |
| Same key, different request | `422` |
| No key, or a key over 255 characters | `400` |
| Your handler throws | Nothing is stored. The key is released, so a retry resumes straight away |

The status codes follow the IETF
[Idempotency-Key header draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/).
The replay header is the one Stripe uses. A 4xx answer, such as a card
decline, counts as a result: it is stored and replayed, never retried.

## How it works

Each key is one row in the `idempotency_keys` table. The row holds a hash of
the request, a lease, the result of each finished phase, and the final
response.

1. **Claim.** The first attempt inserts the row and takes a lease: a random
   token plus an expiry time. A later attempt replays the stored response,
   or gets `409` while the lease is live. Once the lease has run out, a
   later attempt takes over. That is how a crashed request is resumed.
2. **Fence.** Every write after the claim first locks the row and checks the
   token is still this attempt's. Suppose an attempt stalls past its lease,
   another takes over, and then the first wakes up. The first can no longer
   commit anything, and gets `409` instead. Each finished phase renews the
   lease, so a slow request that keeps making progress is never taken over.
3. **Phases.** An atomic phase's writes and its "done" record commit
   together, so a crash leaves either both or neither. An external call can
   happen and then be lost before it is recorded. The retry then makes the
   same call with the same downstream key, and the other system returns its
   first answer.
4. **Respond.** The response is stored as `json`, not `jsonb`: `jsonb`
   reorders keys, and a replay should match the original exactly. The tests
   caught this.

Correctness never depends on clocks. Two servers whose clocks disagree can
both believe the lease has expired. The token check still lets only one of
them write. Clock skew only changes how soon a stalled request is taken over.

## Crash-test your own handlers

The harness is part of the library:

```ts
import { testEveryCrashPoint } from "idempotency-keys";

const points = await testEveryCrashPoint({
  reset: () => truncateTables(),
  attempt: (hooks) => run({ db, now: clock.now, hooks }, request, handler),
  expireLease: () => clock.advance(31_000),
  check: async ({ crashedAt }) => {
    expect(await countOrders()).toBe(1);
    expect(processor.charges).toBe(1);
  },
});
```

It first runs the request cleanly to list every point it passes through:

```
claim:before-commit, claim:after-commit,
atomic:order_created:before, atomic:order_created:before-commit, atomic:order_created:after-commit,
external:charge_created:before-call, external:charge_created:after-call,
external:charge_created:before-commit, external:charge_created:after-commit,
atomic:order_paid:before, atomic:order_paid:before-commit, atomic:order_paid:after-commit,
complete:before-commit, complete:after-commit
```

Then, for each point, it:

1. crashes the request there, by throwing inside the open transaction so
   Postgres rolls it back as it would for a dead connection;
2. retries straight away (expecting `409`, unless nothing had committed yet);
3. retries after the lease expires;
4. retries once more, which must be a byte-identical replay;
5. runs your checks.

## How it's tested

```
npm test                                       # PGlite: Postgres compiled to WebAssembly, no server
DATABASE_URL=postgres://... npm test           # also on a real Postgres server, as in CI
```

- **Every crash point:** the harness above, on a successful payment and on
  a declined one.
- **Random faults:** fast-check generates sequences of retries. Before each
  one, some time passes. During it, the attempt may crash at any point, or
  the payment processor may fail. It can fail before charging, or after
  charging with the reply lost. After every step there is at most one
  order and one charge, and no two answers differ. Once the faults stop,
  the request completes with exactly one order and one charge.
- **Stalled requests:** an attempt frozen past its lease can't record its
  charge or its phase after another attempt has taken over. A slow attempt
  that keeps finishing phases is never taken over.
- **Concurrency on real Postgres:**
  - 50 identical requests at once run the handler once; the others get
    `409` or a replay.
  - 50 different keys run in parallel without interfering.

Each of these deliberate bugs makes the tests fail:

- removing the token check;
- not skipping finished phases;
- ignoring the lease at claim time;
- not renewing the lease per phase;
- not releasing the key after an error;
- deriving the downstream key from the attempt instead of the request.

## Limits

- **Code between phases reruns on every attempt.** Keep it free of side
  effects. Put writes in `flow.atomic` and calls to other systems in
  `flow.external`.
- **External systems must honour idempotency keys.** Stripe does, for 24
  hours. For one that doesn't, record what you are about to do in an atomic
  phase first, then check the other system for it before calling again.
- **Phase results and responses must be JSON-serialisable.** They come back
  through JSON on the first attempt too, so the first run and a replay see
  the same values.
- **Old keys are not deleted automatically.** Call
  `deleteExpired(db, before)` on a schedule. Stripe keeps keys for 24 hours.
- **Not published to npm yet.**

## Credit

The design follows Brandur Leach's
[Implementing Stripe-like Idempotency Keys in Postgres](https://brandur.org/idempotency-keys):
atomic phases and recovery points. This library adds three things:

- fencing tokens;
- phase results that are recorded and replayed;
- a harness that crashes at every point.

## License

MIT
