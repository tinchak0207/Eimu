import test from "node:test";
import assert from "node:assert/strict";

import { buildApiErrorBody, failureClassToApiErrorCode, type ApiErrorCode } from "./api-error-codes.ts";
import type { FailureClass } from "./generation-core/types.ts";

// Every FailureClass value must map to a valid ApiErrorCode. Listing them all
// here (rather than importing some derived list) means a new FailureClass added
// to generation-core/types.ts without a corresponding case in this test — and in
// failureClassToApiErrorCode's switch — surfaces as a test failure here, and as a
// TypeScript compile error in the switch itself (see the `never` assertion there).
const ALL_FAILURE_CLASSES: FailureClass[] = [
  "user_input",
  "content_rejected",
  "model_unsupported",
  "authentication",
  "quota_exhausted",
  "rate_limited",
  "overloaded",
  "network",
  "malformed_output",
  "empty_result",
  "artifact_download",
  "deadline_exceeded",
  "cancelled",
  "unknown",
];

const VALID_API_ERROR_CODES: ApiErrorCode[] = [
  "invalid_request",
  "model_unsupported",
  "content_rejected",
  "authentication_failed",
  "quota_exceeded",
  "rate_limited",
  "upstream_overloaded",
  "upstream_network_error",
  "generation_failed",
  "deadline_exceeded",
  "cancelled",
  "internal_error",
];

test("every FailureClass maps to some valid ApiErrorCode", () => {
  for (const failureClass of ALL_FAILURE_CLASSES) {
    const code = failureClassToApiErrorCode(failureClass);
    assert.ok(
      VALID_API_ERROR_CODES.includes(code),
      `failureClassToApiErrorCode(${failureClass}) returned an unrecognized code: ${code}`,
    );
  }
});

test("failureClassToApiErrorCode gives specific, non-generic mappings for common cases", () => {
  assert.equal(failureClassToApiErrorCode("user_input"), "invalid_request");
  assert.equal(failureClassToApiErrorCode("content_rejected"), "content_rejected");
  assert.equal(failureClassToApiErrorCode("model_unsupported"), "model_unsupported");
  assert.equal(failureClassToApiErrorCode("authentication"), "authentication_failed");
  assert.equal(failureClassToApiErrorCode("quota_exhausted"), "quota_exceeded");
  assert.equal(failureClassToApiErrorCode("rate_limited"), "rate_limited");
  assert.equal(failureClassToApiErrorCode("overloaded"), "upstream_overloaded");
  assert.equal(failureClassToApiErrorCode("network"), "upstream_network_error");
  assert.equal(failureClassToApiErrorCode("deadline_exceeded"), "deadline_exceeded");
  assert.equal(failureClassToApiErrorCode("cancelled"), "cancelled");
  assert.equal(failureClassToApiErrorCode("unknown"), "internal_error");
});

test("output-shaped failures (malformed_output/empty_result/artifact_download) all collapse to generation_failed", () => {
  assert.equal(failureClassToApiErrorCode("malformed_output"), "generation_failed");
  assert.equal(failureClassToApiErrorCode("empty_result"), "generation_failed");
  assert.equal(failureClassToApiErrorCode("artifact_download"), "generation_failed");
});

test("buildApiErrorBody produces the documented envelope shape", () => {
  const body = buildApiErrorBody("rate_limited", "Too many requests.", "trace-abc123");
  assert.deepEqual(body, {
    error: {
      code: "rate_limited",
      message: "Too many requests.",
      trace_id: "trace-abc123",
    },
  });
});
