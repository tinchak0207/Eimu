import test from "node:test";
import assert from "node:assert/strict";
import {
  bizTenantId,
  clampPagination,
  computePlatformStats,
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  HISTORY_MAX_OFFSET,
  isControlPlaneUnavailableError,
  toJobStatusSnapshot,
  type PlatformAggregateRow,
} from "./status-query";
import type { GenerationJob, GenerationJobStatus } from "./types";

function fakeJob(overrides: Partial<GenerationJob> = {}): GenerationJob {
  const base: GenerationJob = {
    id: "job_1",
    tenantId: "biz:key1",
    apiKeyId: "key1",
    billingUserId: 42,
    source: "biz",
    idempotencyKey: null,
    requestHash: "abc",
    kind: "image_generate",
    routingClass: "generic",
    modelId: "gpt-image-2",
    size: "1024x1024",
    ratio: "1:1",
    resolution: "1k",
    quality: "fast",
    promptCiphertext: "SECRET_CIPHER_TEXT",
    workflow: { prompt: "secret prompt", references: [{ url: "https://example.invalid/ref.png", mimeType: "image/png" }] },
    responseFormat: "b64_json",
    callbackUrl: null,
    retryOfTaskId: null,
    primaryResultId: null,
    status: "queued",
    requestedCount: 1,
    completedCount: 0,
    attemptCount: 0,
    billingAmount: 100,
    deadlineAt: new Date("2026-08-01T00:00:00Z"),
    availableAt: new Date("2026-08-01T00:00:00Z"),
    leaseOwner: null,
    leaseExpiresAt: null,
    failureClass: null,
    failureDetail: null,
    result: null,
    createdAt: new Date("2026-08-01T01:00:00Z"),
    startedAt: null,
    finishedAt: null,
    updatedAt: new Date("2026-08-01T01:00:00Z"),
  };
  return { ...base, ...overrides };
}

const STATUS_TO_TASK_STATE: Record<GenerationJobStatus, string> = {
  pending_billing: "queued",
  billing_unknown: "unknown",
  queued: "queued",
  leased: "running",
  submitting: "running",
  running: "running",
  submit_unknown: "unknown",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  refunded: "refunded",
};

test("快照只投影診斷字段，prompt 密文 / workflow 內部 / 計費字段一律不出控制面", () => {
  const snapshot = toJobStatusSnapshot(fakeJob());
  assert.equal(snapshot.id, "job_1");
  assert.equal(snapshot.object, "image_generation.task");
  assert.equal(snapshot.task_id, "job_1");
  assert.ok(!("promptCiphertext" in snapshot), "不得帶 prompt 密文");
  assert.ok(!("workflow" in snapshot), "不得帶 workflow 內部結構");
  assert.ok(!("prompt" in snapshot), "不得帶明文的 prompt");
  assert.ok(!("billingAmount" in snapshot), "不得帶計費金額");
  assert.ok(!("requestHash" in snapshot), "不得帶請求雜湊");
  assert.ok(!("leaseOwner" in snapshot), "不得帶租約內部字段");
});

test("快照的 task_state 是 OpenAI 相容投影，內部原始狀態保留在 status", () => {
  for (const [status, expected] of Object.entries(STATUS_TO_TASK_STATE)) {
    const snapshot = toJobStatusSnapshot(fakeJob({ status: status as GenerationJobStatus }));
    assert.equal(snapshot.status, status, "原始狀態必須保留，診斷才看得出 submit_unknown 這種卡住的狀態");
    assert.equal(snapshot.task_state, expected, `${status} 應投影為 ${expected}`);
  }
});

test("快照的 task_url 按 kind 指到正確的結果端點", () => {
  const image = toJobStatusSnapshot(fakeJob());
  assert.equal(image.task_url, "/v1/images/job_1");
  const video = toJobStatusSnapshot(fakeJob({ kind: "video_generate" }));
  assert.equal(video.task_url, "/v1/videos/job_1");
});

test("快照時間給 epoch 秒與 ISO 兩種，null 欄位保持 null", () => {
  const snapshot = toJobStatusSnapshot(fakeJob());
  assert.equal(snapshot.created, Math.floor(new Date("2026-08-01T01:00:00Z").getTime() / 1000));
  assert.equal(snapshot.created_at, "2026-08-01T01:00:00.000Z");
  assert.equal(snapshot.started_at, null);
  assert.equal(snapshot.finished_at, null);
  assert.equal(snapshot.failure_class, null);
});

test("bizTenantId 以 biz: 前綴把金鑰隔離成獨立 tenant", () => {
  assert.equal(bizTenantId("key1"), "biz:key1");
  assert.equal(bizTenantId("abc123"), "biz:abc123");
});

test("clampPagination 預設、上限、向下取整", () => {
  assert.deepEqual(clampPagination(undefined, undefined), { limit: HISTORY_DEFAULT_LIMIT, offset: 0 });
  assert.deepEqual(clampPagination(500, 0), { limit: HISTORY_MAX_LIMIT, offset: 0 });
  assert.deepEqual(clampPagination(0, 0), { limit: 1, offset: 0 });
  assert.deepEqual(clampPagination(2.9, 3.9), { limit: 2, offset: 3 });
  assert.deepEqual(clampPagination(-5, -1), { limit: 1, offset: 0 });
  assert.deepEqual(clampPagination("30", "10"), { limit: 30, offset: 10 });
  assert.deepEqual(clampPagination(undefined, 99_999), { limit: HISTORY_DEFAULT_LIMIT, offset: HISTORY_MAX_OFFSET });
});

test("computePlatformStats 只算成功/失敗，排隊中的不進分母——不灌水", () => {
  const rows: PlatformAggregateRow[] = [
    { model_id: "gpt-image-2", total_jobs: 10, succeeded_jobs: 7, failed_jobs: 2 },
    // 5 筆全在跑：total 有值，但沒有終結樣本，不得拉低/墊高成功率。
    { model_id: "veo-3.1", total_jobs: 5, succeeded_jobs: 0, failed_jobs: 0 },
  ];
  const stats = computePlatformStats(rows, new Date("2026-08-01T00:00:00Z"));

  assert.equal(stats.total_jobs, 15);
  assert.equal(stats.succeeded_jobs, 7);
  assert.equal(stats.failed_jobs, 2);
  assert.equal(stats.active_jobs, 6);
  // 7 / (7+2)，不是 7 / 15。
  assert.ok(Math.abs(stats.success_rate! - 7 / 9) < 1e-9);
  assert.equal(stats.generated_at, "2026-08-01T00:00:00.000Z");

  const image = stats.by_model.find((row) => row.model === "gpt-image-2");
  const video = stats.by_model.find((row) => row.model === "veo-3.1");
  assert.ok(Math.abs(image!.success_rate! - 7 / 9) < 1e-9);
  assert.equal(video!.success_rate, null, "無終結樣本的模型成功率必須是 null，不能假裝 0");
});

test("computePlatformStats 空輸入 → 全零、null 成功率、空 by_model", () => {
  const stats = computePlatformStats([], new Date("2026-08-01T00:00:00Z"));
  assert.deepEqual(stats, {
    total_jobs: 0,
    succeeded_jobs: 0,
    failed_jobs: 0,
    active_jobs: 0,
    success_rate: null,
    by_model: [],
    generated_at: "2026-08-01T00:00:00.000Z",
  });
});

test("computePlatformStats 對髒數字容錯（NULL / NaN / 負值一律當 0）", () => {
  const stats = computePlatformStats([{ model_id: "m", total_jobs: null, succeeded_jobs: NaN, failed_jobs: -3 }]);
  assert.equal(stats.total_jobs, 0);
  assert.equal(stats.success_rate, null);
});

test("isControlPlaneUnavailableError 只認 DB 未配置訊息的錯誤", () => {
  assert.equal(
    isControlPlaneUnavailableError(new Error("GENERATION_DATABASE_URL or DATABASE_URL is required for the generation control plane.")),
    true,
  );
  assert.equal(isControlPlaneUnavailableError(new Error("connection refused")), false);
  assert.equal(isControlPlaneUnavailableError("string error"), false);
  assert.equal(isControlPlaneUnavailableError(null), false);
});
