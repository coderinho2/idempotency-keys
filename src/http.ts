import type { Json, Outcome } from "./types.js";

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Json;
}

const error = (status: number, message: string, headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers,
  body: { error: { type: "idempotency_error", message } },
});

/**
 * Status codes follow the IETF Idempotency-Key header draft
 * (draft-ietf-httpapi-idempotency-key-header): 400 without a key, 409 while
 * the key is in use, 422 when it is reused for a different request.
 */
export function toHttp(outcome: Outcome): HttpResponse {
  switch (outcome.kind) {
    case "executed":
      return { status: outcome.response.status, headers: {}, body: outcome.response.body };
    case "replayed":
      // The header Stripe sets on a replayed response.
      return { status: outcome.response.status, headers: { "Idempotent-Replayed": "true" }, body: outcome.response.body };
    case "in_progress":
      return error(409, "A request with this Idempotency-Key is still being processed. Retry later.", { "Retry-After": String(outcome.retryAfterSeconds) });
    case "lease_lost":
      return error(409, "This attempt took too long and another one took over. Retry to get its result.", { "Retry-After": "1" });
    case "mismatch":
      return error(422, "This Idempotency-Key was already used for a different request.");
    case "missing_key":
      return error(400, "This endpoint requires an Idempotency-Key header.");
    case "invalid_key":
      return error(400, "The Idempotency-Key header must be at most 255 characters.");
  }
}
