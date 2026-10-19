import test from "node:test";
import assert from "node:assert/strict";

import { getOrCreateTraceId, withTraceId, TRACE_ID_HEADER } from "./request-trace.ts";

test("trusts a valid inbound X-Request-Id header", () => {
  const headers = new Headers({ "x-request-id": "client-supplied-id-123" });
  assert.equal(getOrCreateTraceId(headers), "client-supplied-id-123");
});

test("accepts an object with a .headers property (e.g. NextRequest-like)", () => {
  const request = { headers: new Headers({ "x-request-id": "req-abc.def-123" }) };
  assert.equal(getOrCreateTraceId(request), "req-abc.def-123");
});

test("generates a fresh id when no inbound header is present", () => {
  const headers = new Headers();
  const traceId = headers.get("x-request-id");
  assert.equal(traceId, null);
  const generated = getOrCreateTraceId(headers);
  assert.match(generated, /^[0-9a-f-]{36}$/i);
});

test("rejects a malformed inbound id (too short) and generates a new one instead", () => {
  const headers = new Headers({ "x-request-id": "short" });
  const generated = getOrCreateTraceId(headers);
  assert.notEqual(generated, "short");
  assert.match(generated, /^[0-9a-f-]{36}$/i);
});

test("rejects an inbound id containing disallowed characters", () => {
  const headers = new Headers({ "x-request-id": "has a space and $ymbol!" });
  const generated = getOrCreateTraceId(headers);
  assert.notEqual(generated, "has a space and $ymbol!");
  assert.match(generated, /^[0-9a-f-]{36}$/i);
});

test("rejects an inbound id that is too long", () => {
  const tooLong = "a".repeat(200);
  const headers = new Headers({ "x-request-id": tooLong });
  const generated = getOrCreateTraceId(headers);
  assert.notEqual(generated, tooLong);
});

test("withTraceId adds the header without dropping existing headers or body", async () => {
  const original = new Response(JSON.stringify({ ok: true }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });

  const withTrace = withTraceId(original, "trace-xyz");

  assert.equal(withTrace.headers.get(TRACE_ID_HEADER), "trace-xyz");
  assert.equal(withTrace.headers.get("Content-Type"), "application/json");
  assert.equal(withTrace.status, 201);
  assert.deepEqual(await withTrace.json(), { ok: true });
});
