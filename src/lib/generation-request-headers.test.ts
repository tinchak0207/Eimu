import test from "node:test";
import assert from "node:assert/strict";

import { isValidTraceId, TRACE_ID_HEADER } from "./request-trace.ts";
import {
  GENERATION_TRACE_ID_HEADER,
  buildGenerationRequestHeaders,
  mcpGenerationIdempotencyKey,
  newGenerationTraceId,
  resolveGenerationTraceId,
} from "./generation-request-headers.ts";

test("trace header name is the single global one (no second header invented)", () => {
  assert.equal(GENERATION_TRACE_ID_HEADER, TRACE_ID_HEADER);
  assert.equal(GENERATION_TRACE_ID_HEADER, "X-Request-Id");
});

test("same explicit traceId is reused across retries of one logical request", () => {
  const first = buildGenerationRequestHeaders({ traceId: "retry-stable-id-12345" });
  const retry = buildGenerationRequestHeaders({ traceId: "retry-stable-id-12345" });
  assert.equal(first["X-Request-Id"], "retry-stable-id-12345");
  assert.equal(retry["X-Request-Id"], "retry-stable-id-12345");
  assert.equal(first["X-Request-Id"], retry["X-Request-Id"]);
});

test("distinct fresh requests produce distinct trace ids", () => {
  const a = buildGenerationRequestHeaders();
  const b = buildGenerationRequestHeaders();
  assert.notEqual(a["X-Request-Id"], b["X-Request-Id"]);
  assert.ok(isValidTraceId(a["X-Request-Id"]));
  assert.ok(isValidTraceId(b["X-Request-Id"]));
});

test("a well-formed inbound X-Request-Id is trusted and echoed", () => {
  const headers = new Headers({ "x-request-id": "inbound-header-id-9876" });
  assert.equal(resolveGenerationTraceId(headers), "inbound-header-id-9876");
  const built = buildGenerationRequestHeaders({ traceId: headers });
  assert.equal(built["X-Request-Id"], "inbound-header-id-9876");
});

test("a request-shaped source with .headers is accepted", () => {
  const request = { headers: new Headers({ "x-request-id": "req-shaped.abc-123" }) };
  assert.equal(resolveGenerationTraceId(request), "req-shaped.abc-123");
});

test("missing inbound header generates a valid fresh id", () => {
  const generated = resolveGenerationTraceId(new Headers());
  assert.ok(isValidTraceId(generated));
});

test("a malformed explicit id is rejected and replaced (no header smuggling)", () => {
  const generated = resolveGenerationTraceId("bad id with spaces!!");
  assert.notEqual(generated, "bad id with spaces!!");
  assert.ok(isValidTraceId(generated));
});

test("idempotency key is carried when set and omitted when blank", () => {
  const withKey = buildGenerationRequestHeaders({ idempotencyKey: "  abc-key  " });
  assert.equal(withKey["Idempotency-Key"], "abc-key");
  assert.equal(buildGenerationRequestHeaders({ idempotencyKey: "" })["Idempotency-Key"], undefined);
  assert.equal(buildGenerationRequestHeaders({ idempotencyKey: null })["Idempotency-Key"], undefined);
  assert.equal(buildGenerationRequestHeaders()["Idempotency-Key"], undefined);
});

test("authorization is passed through and never inferred", () => {
  const withAuth = buildGenerationRequestHeaders({ authorization: "Bearer x" });
  assert.equal(withAuth.Authorization, "Bearer x");
  assert.equal(buildGenerationRequestHeaders().Authorization, undefined);
});

test("MCP idempotency key is bound to tool name and trace id", () => {
  assert.equal(mcpGenerationIdempotencyKey("generate_image", "trace-1"), "mcp:generate_image:trace-1");
});

test("newGenerationTraceId always yields an acceptable id", () => {
  assert.ok(isValidTraceId(newGenerationTraceId()));
});
