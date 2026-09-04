import assert from "node:assert/strict";
import test from "node:test";

import { applyExtendedDeadline, shouldExtendQueueDeadline } from "./worker-service.ts";
import type { GenerationJob } from "./types.ts";

function job(overrides: Partial<GenerationJob> = {}): GenerationJob {
  const now = new Date("2026-08-30T00:00:00.000Z");
  return {
    id: "job-1",
    tenantId: "biz:key-1",
    apiKeyId: "key-1",
    billingUserId: 7,
    source: "biz",
    idempotencyKey: "request-1",
    requestHash: "hash",
    kind: "video_generate",
    routingClass: "generic",
    modelId: "veo-3",
    size: "1024x1024",
    ratio: "16:9",
    resolution: "1k",
    quality: "fast",
    promptCiphertext: "v1.a.b.c",
    workflow: {},
    responseFormat: "url",
    callbackUrl: null,
    status: "queued",
    requestedCount: 1,
    completedCount: 0,
    attemptCount: 0,
    billingAmount: 10,
    deadlineAt: now,
    availableAt: now,
    leaseOwner: null,
    leaseExpiresAt: null,
    failureClass: null,
    failureDetail: null,
    result: null,
    createdAt: now,
    startedAt: now,
    finishedAt: null,
    updatedAt: now,
    ...overrides,
  };
}

test("shouldExtendQueueDeadline：deadline 快到期 + 可恢復狀態（cooldown/capacity/accounts）→ true", () => {
  const base = { startedAt: new Date("2026-08-30T00:00:00.000Z") };
  const now = new Date("2026-08-30T00:00:00.000Z").getTime();
  for (const reason of ["suppliers_cooldown", "capacity_saturated", "accounts_unhealthy"] as const) {
    const result = shouldExtendQueueDeadline({
      diagnosisReason: reason,
      deadlineAt: new Date(now + 10_000),
      startedAt: base.startedAt,
      now,
    });
    assert.equal(result, true, `${reason} 應順延`);
  }
});

test("shouldExtendQueueDeadline：deadline 離到期還早 → false（不提前續）", () => {
  const startedAt = new Date("2026-08-30T00:00:00.000Z");
  const now = startedAt.getTime();
  const result = shouldExtendQueueDeadline({
    diagnosisReason: "capacity_saturated",
    deadlineAt: new Date(now + 60_000),
    startedAt,
    now,
  });
  assert.equal(result, false);
});

test("shouldExtendQueueDeadline：超過排隊 20min 上限 → false（不無限掛單）", () => {
  const startedAt = new Date("2026-08-30T00:00:00.000Z");
  const now = startedAt.getTime() + 21 * 60_000;
  const result = shouldExtendQueueDeadline({
    diagnosisReason: "capacity_saturated",
    deadlineAt: new Date(now + 10_000),
    startedAt,
    now,
  });
  assert.equal(result, false);
});

test("shouldExtendQueueDeadline：純死路狀態 → false（suppliers_disabled / supplier_excluded / 未 seed）", () => {
  const startedAt = new Date("2026-08-30T00:00:00.000Z");
  const now = startedAt.getTime();
  for (const reason of ["suppliers_disabled", "supplier_excluded", "model_not_provisioned", "capability_disabled", "routing_class_unmet", "variant_unsupported"] as const) {
    const result = shouldExtendQueueDeadline({
      diagnosisReason: reason,
      deadlineAt: new Date(now + 10_000),
      startedAt,
      now,
    });
    assert.equal(result, false, `${reason} 不應順延`);
  }
});

test("shouldExtendQueueDeadline：無 started_at → false", () => {
  const now = new Date("2026-08-30T00:00:00.000Z").getTime();
  const result = shouldExtendQueueDeadline({
    diagnosisReason: "capacity_saturated",
    deadlineAt: new Date(now + 10_000),
    startedAt: null,
    now,
  });
  assert.equal(result, false);
});

test("applyExtendedDeadline：把 extend 寫入 DB 的 deadline 同步回內存 job.deadlineAt（病灶 D）", () => {
  const j = job();
  const original = j.deadlineAt;
  const extendedTo = new Date("2026-08-30T00:15:00.000Z");
  applyExtendedDeadline(j, extendedTo);
  assert.equal(j.deadlineAt, extendedTo);
  assert.notEqual(j.deadlineAt, original);
});

test("applyExtendedDeadline：extend 失敗（null）時內存 deadline 不變", () => {
  const j = job();
  const original = j.deadlineAt;
  applyExtendedDeadline(j, null);
  assert.equal(j.deadlineAt, original);
});