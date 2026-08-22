import assert from "node:assert/strict";
import test from "node:test";
import { classifySupplierFailure, SupplierRequestError } from "./failure-classifier.ts";

const NOW = new Date("2026-07-29T00:00:00.000Z");

test("429 respects Retry-After and enters a durable cooldown", () => {
  const result = classifySupplierFailure(new SupplierRequestError("too many requests", 429, "120"), NOW);
  assert.equal(result.failureClass, "rate_limited");
  assert.equal(result.retryable, true);
  assert.equal(result.switchSupplier, true);
  assert.equal(result.cooldownUntil?.toISOString(), "2026-07-29T00:02:00.000Z");
});

test("401 and 403 quarantine the credential account rather than retrying it", () => {
  for (const status of [401, 403]) {
    const result = classifySupplierFailure(new SupplierRequestError("unauthorized", status), NOW);
    assert.equal(result.failureClass, "authentication");
    assert.equal(result.quarantineSupplier, true);
    assert.equal(result.switchSupplier, true);
  }
});

test("408 and 5xx are overload failures, never misclassified as Adobe scope failures", () => {
  for (const status of [408, 500, 503]) {
    const result = classifySupplierFailure(new SupplierRequestError("system under load", status), NOW);
    assert.equal(result.failureClass, "overloaded");
    assert.equal(result.retryable, true);
    assert.equal(result.quarantineSupplier, false);
  }
});

test("empty output and artifact download failure have different cooldown classes", () => {
  const empty = classifySupplierFailure(new Error("Supplier result was empty."), NOW);
  const download = classifySupplierFailure(new Error("Artifact download failed: HTTP 502."), NOW);
  assert.equal(empty.failureClass, "empty_result");
  assert.equal(download.failureClass, "artifact_download");
  assert.ok((empty.cooldownUntil?.getTime() ?? 0) > (download.cooldownUntil?.getTime() ?? 0));
});

test("invalid input and unsupported model stop supplier fan-out", () => {
  const input = classifySupplierFailure(new SupplierRequestError("unsupported size", 400), NOW);
  const model = classifySupplierFailure(new SupplierRequestError("model not found", 404), NOW);
  assert.equal(input.failureClass, "user_input");
  assert.equal(input.retryable, false);
  assert.equal(model.failureClass, "model_unsupported");
  assert.equal(model.switchSupplier, false);
});

test("451 legal_error is a permanent content rejection, never retried", () => {
  const result = classifySupplierFailure(
    new SupplierRequestError('video submit failed: 451 {"error_code":"legal_error"}', 451),
    NOW,
  );
  assert.equal(result.failureClass, "content_rejected");
  assert.equal(result.retryable, false);
  assert.equal(result.switchSupplier, false);
  assert.equal(result.quarantineSupplier, false);
});

test("503 wrapping a legal_error body is still classified as content rejection", () => {
  const result = classifySupplierFailure(
    new SupplierRequestError("Upstream is temporarily unavailable", 503, null, '{"error_code":"legal_error"}'),
    NOW,
  );
  assert.equal(result.failureClass, "content_rejected");
  assert.equal(result.retryable, false);
});

