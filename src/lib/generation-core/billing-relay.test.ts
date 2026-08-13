import assert from "node:assert/strict";
import test from "node:test";

import { signBillingRelayRequest, verifyBillingRelayRequest } from "./billing-relay.ts";

test("billing relay signatures bind timestamp and exact request body", () => {
  const secret = "test-secret";
  const timestamp = "1760000000000";
  const rawBody = '{"job_id":"job-1","operation":"reserve","user_id":7,"amount":10}';
  const signature = signBillingRelayRequest(secret, timestamp, rawBody);
  assert.equal(verifyBillingRelayRequest({ secret, timestamp, signature, rawBody, now: Number(timestamp) }), true);
  assert.equal(verifyBillingRelayRequest({ secret, timestamp, signature, rawBody: `${rawBody} `, now: Number(timestamp) }), false);
});

test("billing relay rejects stale requests", () => {
  const timestamp = "1760000000000";
  const rawBody = "{}";
  const signature = signBillingRelayRequest("test-secret", timestamp, rawBody);
  assert.equal(
    verifyBillingRelayRequest({ secret: "test-secret", timestamp, signature, rawBody, now: Number(timestamp) + 300_001 }),
    false,
  );
});
