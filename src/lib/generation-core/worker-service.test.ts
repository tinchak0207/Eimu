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
test("generationBudgetMs：影片族（video_generate/avatar/lipsync）= 25 分鐘，其餘 15 分鐘", () => {
  // INC-VIDEO-0927：napi 單次 attempt 實測最長 993.9s、30s 檔成功單均 868s，
  // 舊的 15 分鐘開工預算會誤殺慢而健康的影片上游。
  assert.equal(generationBudgetMs("video_generate"), 25 * 60_000);
  assert.equal(generationBudgetMs("avatar"), 25 * 60_000);
  assert.equal(generationBudgetMs("lipsync"), 25 * 60_000);
  assert.equal(generationBudgetMs("image_generate"), 15 * 60_000);
  assert.equal(generationBudgetMs("image_edit"), 15 * 60_000);
  assert.equal(generationBudgetMs("tts"), 15 * 60_000);
});

test("欠費無替補即時失敗：上次失敗為 quota_exhausted 且無可用供應商 → fail fast", () => {
  for (const diagnosisReason of ["supplier_excluded", "suppliers_cooldown", "accounts_unhealthy"] as const) {
    assert.equal(shouldFailFastOnExhaustedSupply({ lastFailureClass: "quota_exhausted", diagnosisReason }), true, diagnosisReason);
  }
});

test("欠費無替補即時失敗：別的健康供應商只是忙、或上次失敗不是欠費 → 照舊排隊", () => {
  assert.equal(shouldFailFastOnExhaustedSupply({ lastFailureClass: "quota_exhausted", diagnosisReason: "capacity_saturated" }), false);
  assert.equal(shouldFailFastOnExhaustedSupply({ lastFailureClass: "overloaded", diagnosisReason: "suppliers_cooldown" }), false);
  assert.equal(shouldFailFastOnExhaustedSupply({ lastFailureClass: null, diagnosisReason: "supplier_excluded" }), false);
});

test("H-fix：pricing_config 無替補 → 以 pricing_config 真因即時終結，不空轉", () => {
  for (const diagnosisReason of ["supplier_excluded", "suppliers_cooldown", "accounts_unhealthy"] as const) {
    assert.equal(failFastClassForExhaustedSupply({ lastFailureClass: "pricing_config", diagnosisReason }), "pricing_config", diagnosisReason);
    assert.equal(failFastClassForExhaustedSupply({ lastFailureClass: "quota_exhausted", diagnosisReason }), "quota_exhausted", diagnosisReason);
  }
  assert.equal(failFastClassForExhaustedSupply({ lastFailureClass: "pricing_config", diagnosisReason: "capacity_saturated" }), null);
  assert.equal(failFastClassForExhaustedSupply({ lastFailureClass: "overloaded", diagnosisReason: "supplier_excluded" }), null);
});
