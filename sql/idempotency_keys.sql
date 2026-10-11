-- One row per (scope, key). Run once; `migrate(db)` runs the same statement.
create table if not exists idempotency_keys (
  id              bigserial primary key,
  scope           text not null,
  key             text not null,
  -- sha256 of method, path and body: a reused key must describe the same request.
  request_hash    text not null,
  created_at      timestamptz not null,

  -- The lease. locked_by is a fencing token: an attempt may only write while
  -- it still holds it, so one that stalled past its lease cannot commit.
  locked_by       text,
  locked_until    timestamptz,

  -- Progress: the result of each finished phase, by name.
  recovery_point  text not null default 'started',
  phases          jsonb not null default '{}'::jsonb,

  -- The final response, replayed to every later attempt. json, not jsonb:
  -- jsonb reorders keys, and a replay should match the original exactly.
  response_status integer,
  response_body   json,
  completed_at    timestamptz,

  unique (scope, key)
);

create index if not exists idempotency_keys_created_at on idempotency_keys (created_at);
