import assert from "node:assert/strict";
import test from "node:test";

import { failFastClassForExhaustedSupply, applyExtendedDeadline, generationBudgetMs, shouldExtendQueueDeadline, shouldFailFastOnExhaustedSupply } from "./worker-service.ts";
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

test("shouldExtendQueueDeadline：deadline 快到期 + 可恢复状态（cooldown/capacity/accounts）→ true", () => {
  const base = { startedAt: new Date("2026-08-30T00:00:00.000Z") };
  const now = new Date("2026-08-30T00:00:00.000Z").getTime();
  for (const reason of ["suppliers_cooldown", "capacity_saturated", "accounts_unhealthy"] as const) {
    const result = shouldExtendQueueDeadline({
      diagnosisReason: reason,
      deadlineAt: new Date(now + 10_000),
      startedAt: base.startedAt,
      now,
    });
    assert.equal(result, true, `${reason} 应顺延`);
  }
});

test("shouldExtendQueueDeadline：deadline 离到期还早 → false（不提前续）", () => {
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

test("shouldExtendQueueDeadline：超过排队 20min 上限 → false（不无限挂单）", () => {
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

test("shouldExtendQueueDeadline：纯死路状态 → false（suppliers_disabled / supplier_excluded / 未 seed）", () => {
  const startedAt = new Date("2026-08-30T00:00:00.000Z");
  const now = startedAt.getTime();
  for (const reason of ["suppliers_disabled", "supplier_excluded", "model_not_provisioned", "capability_disabled", "routing_class_unmet", "variant_unsupported"] as const) {
    const result = shouldExtendQueueDeadline({
      diagnosisReason: reason,
      deadlineAt: new Date(now + 10_000),
      startedAt,
      now,
    });
    assert.equal(result, false, `${reason} 不应顺延`);
  }
});

test("shouldExtendQueueDeadline：无 started_at → false", () => {
  const now = new Date("2026-08-30T00:00:00.000Z").getTime();
  const result = shouldExtendQueueDeadline({
    diagnosisReason: "capacity_saturated",
    deadlineAt: new Date(now + 10_000),
    startedAt: null,
    now,
  });
  assert.equal(result, false);
});

test("applyExtendedDeadline：把 extend 写入 DB 的 deadline 同步回内存 job.deadlineAt（病灶 D）", () => {
  const j = job();
  const original = j.deadlineAt;
  const extendedTo = new Date("2026-08-30T00:15:00.000Z");
  applyExtendedDeadline(j, extendedTo);
  assert.equal(j.deadlineAt, extendedTo);
  assert.notEqual(j.deadlineAt, original);
});

test("applyExtendedDeadline：extend 失败（null）时内存 deadline 不变", () => {
  const j = job();
  const original = j.deadlineAt;
  applyExtendedDeadline(j, null);
  assert.equal(j.deadlineAt, original);
});
test("generationBudgetMs：影片族（video_generate/avatar/lipsync）= 25 分钟，其余 15 分钟", () => {
  // INC-VIDEO-0927：napi 单次 attempt 实测最长 993.9s、30s 档成功单均 868s，
  // 旧的 15 分钟开工预算会误杀慢而健康的影片上游。
  assert.equal(generationBudgetMs("video_generate"), 25 * 60_000);
  assert.equal(generationBudgetMs("avatar"), 25 * 60_000);
  assert.equal(generationBudgetMs("lipsync"), 25 * 60_000);
  assert.equal(generationBudgetMs("image_generate"), 15 * 60_000);
  assert.equal(generationBudgetMs("image_edit"), 15 * 60_000);
  assert.equal(generationBudgetMs("tts"), 15 * 60_000);
});

test("欠费无替补即时失败：上次失败为 quota_exhausted 且无可用供应商 → fail fast", () => {
  for (const diagnosisReason of ["supplier_excluded", "suppliers_cooldown", "accounts_unhealthy"] as const) {
    assert.equal(shouldFailFastOnExhaustedSupply({ lastFailureClass: "quota_exhausted", diagnosisReason }), true, diagnosisReason);
  }
});

test("欠费无替补即时失败：别的健康供应商只是忙、或上次失败不是欠费 → 照旧排队", () => {
  assert.equal(shouldFailFastOnExhaustedSupply({ lastFailureClass: "quota_exhausted", diagnosisReason: "capacity_saturated" }), false);
  assert.equal(shouldFailFastOnExhaustedSupply({ lastFailureClass: "overloaded", diagnosisReason: "suppliers_cooldown" }), false);
  assert.equal(shouldFailFastOnExhaustedSupply({ lastFailureClass: null, diagnosisReason: "supplier_excluded" }), false);
});

test("H-fix：pricing_config 无替补 → 以 pricing_config 真因即时终结，不空转", () => {
  for (const diagnosisReason of ["supplier_excluded", "suppliers_cooldown", "accounts_unhealthy"] as const) {
    assert.equal(failFastClassForExhaustedSupply({ lastFailureClass: "pricing_config", diagnosisReason }), "pricing_config", diagnosisReason);
    assert.equal(failFastClassForExhaustedSupply({ lastFailureClass: "quota_exhausted", diagnosisReason }), "quota_exhausted", diagnosisReason);
  }
  assert.equal(failFastClassForExhaustedSupply({ lastFailureClass: "pricing_config", diagnosisReason: "capacity_saturated" }), null);
  assert.equal(failFastClassForExhaustedSupply({ lastFailureClass: "overloaded", diagnosisReason: "supplier_excluded" }), null);
});
