import assert from "node:assert/strict";
import test from "node:test";
import { generationTaskResponse, taskStatus } from "./task-response.ts";
import type { GenerationJob } from "./types.ts";

function job(status: GenerationJob["status"]): GenerationJob {
  const now = new Date("2026-07-29T00:00:00.000Z");
  return {
    id: "job-1", tenantId: "biz:key-1", apiKeyId: "key-1", billingUserId: 1,
    source: "biz", idempotencyKey: "request-1", requestHash: "hash", kind: "image_generate",
    routingClass: "generic", modelId: "gpt-image-2", size: "1024x1024", ratio: "1:1",
    resolution: "1k", quality: "fast", promptCiphertext: "v1.x.y.z", workflow: {},
    responseFormat: "url", callbackUrl: null, status, requestedCount: 1, completedCount: status === "succeeded" ? 1 : 0,
    retryOfTaskId: null, primaryResultId: status === "succeeded" ? "artifact-1" : null,
    attemptCount: 1, billingAmount: 10, deadlineAt: now, availableAt: now, leaseOwner: null,
    leaseExpiresAt: null, failureClass: status === "failed" ? "overloaded" : null,
    failureDetail: status === "failed" ? "provider unavailable" : null,
    result: status === "succeeded" ? {
      created: 1,
      artifacts: [{ id: "artifact-1", outputIndex: 0, url: "https://blob.example/output.png", mimeType: "image/png", sha256: "a", width: 1, height: 1, endpointLabel: "adobe2api" }],
    } : null,
    createdAt: now, startedAt: null, finishedAt: null, updatedAt: now,
  };
}

test("task status exposes queued/running/terminal states without leaking internal lease states", () => {
  assert.equal(taskStatus(job("pending_billing")), "queued");
  assert.equal(taskStatus(job("leased")), "running");
  assert.equal(taskStatus(job("submit_unknown")), "unknown");
  assert.equal(taskStatus(job("refunded")), "refunded");
});

test("successful task returns stable query and result URLs with durable artifact metadata", () => {
  const response = generationTaskResponse(job("succeeded"));
  assert.equal(response.task_id, "job-1");
  assert.equal(response.status, "succeeded");
  assert.equal(response.task_url, "/v1/images/job-1");
  assert.equal(response.result_url, "/v1/images/job-1/result");
  assert.equal(response.data?.[0]?.url, "https://blob.example/output.png");
});

/**
 * overloaded 曾经只回一句「没有可用容量」，客户分不清是模型没开通、
 * 供应商全下线，还是额度打满 —— 三种情况的处置完全不同
 * （找我们开通 / 等恢复 / 降并发）。调度器的诊断必须能被机器判等。
 */
test("overloaded failures expose the scheduler diagnosis as a separate reason field", () => {
  const failed = job("failed");
  const response = generationTaskResponse({
    ...failed,
    failureDetail: "model_not_provisioned: No supplier declares this model.",
  });

  assert.deepEqual(response.error, {
    code: "overloaded",
    reason: "model_not_provisioned",
    message: "No supplier declares this model.",
  });
});

test("an overloaded detail without a reason prefix is passed through unchanged", () => {
  const failed = job("failed");
  const response = generationTaskResponse({
    ...failed,
    failureDetail: "No eligible supplier capacity is currently available.",
  });

  assert.deepEqual(response.error, {
    code: "overloaded",
    message: "No eligible supplier capacity is currently available.",
  });
});

test("non-overloaded failures keep a colon-bearing message intact", () => {
  const failed = job("failed");
  const response = generationTaskResponse({
    ...failed,
    failureClass: "authentication",
    failureDetail: "upstream rejected the credential: 401",
  });

  assert.deepEqual(response.error, {
    code: "authentication",
    message: "upstream rejected the credential: 401",
  });
});
