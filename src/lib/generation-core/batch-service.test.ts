import test from "node:test";
import assert from "node:assert/strict";
import { QUOTA_PER_COIN } from "../quota-constants";
import { imageGenerationCoins } from "../provider-config";
import { generationCoins } from "../generation-model-catalog";
import type { BizApiKey } from "../biz-api-keys";
import {
  batchItemIdempotencyKey,
  batchRequestHash,
  buildBatchItems,
  buildBatchReconciliationItems,
  computeBatchAggregate,
  computeBatchFailureBreakdown,
  inferBatchItemKind,
  MAX_BATCH_SIZE,
  toBatchItemView,
  toBatchReconciliationItem,
  validateBatchItem,
  validateBatchRequestBody,
  type GenerationBatch,
} from "./batch-service";
import type { GenerationJob, GenerationJobStatus } from "./types";

const IMAGE_MODEL = "gpt-image-2";
const VIDEO_MODEL = "kling-2.5-turbo";

const key: Pick<BizApiKey, "allowedModels"> = { allowedModels: [] };
const restrictedKey: Pick<BizApiKey, "allowedModels"> = { allowedModels: ["nano-banana-2"] };

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
    modelId: IMAGE_MODEL,
    size: "1024x1024",
    ratio: "1:1",
    resolution: "1k",
    quality: "fast",
    promptCiphertext: "SECRET_CIPHER_TEXT",
    workflow: {},
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

function fakeBatch(overrides: Partial<GenerationBatch> = {}): GenerationBatch {
  return {
    id: "batch_1",
    tenantId: "biz:key1",
    status: "open",
    totalCount: 3,
    maxInFlight: null,
    idempotencyKey: null,
    requestHash: "hash",
    failedItems: [],
    createdAt: new Date("2026-08-01T01:00:00Z"),
    completedAt: null,
    updatedAt: new Date("2026-08-01T01:00:00Z"),
    ...overrides,
  };
}

function expectReject(
  result: { ok: boolean; error?: { code: string; type?: string }; code?: string },
  code: string,
): void {
  assert.equal(result.ok, false, `期望被拒（${code}），實際通過`);
  if (result.ok) return;
  // validateBatchItem 的錯誤碼在 error.code；validateBatchRequestBody 的在頂層 code。
  assert.equal(result.error?.code ?? result.code, code);
}

// ── 批級結構驗證 ────────────────────────────────────────────

test("validateBatchRequestBody：合法預設與 max_in_flight", () => {
  const ok = validateBatchRequestBody({ requests: [{ prompt: "a", model: IMAGE_MODEL }] });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.maxInFlight, null);
    assert.equal(ok.requests.length, 1);
  }
  const withInFlight = validateBatchRequestBody({ requests: [{}], max_in_flight: 8 });
  assert.equal(withInFlight.ok, true);
  if (withInFlight.ok) assert.equal(withInFlight.maxInFlight, 8);
});

test("validateBatchRequestBody：形狀錯誤逐碼拒絕", () => {
  expectReject(validateBatchRequestBody(null), "invalid_request_body");
  expectReject(validateBatchRequestBody({}), "missing_requests");
  expectReject(validateBatchRequestBody({ requests: [] }), "empty_requests");
  const tooMany = validateBatchRequestBody({ requests: Array.from({ length: MAX_BATCH_SIZE + 1 }, () => ({})) });
  expectReject(tooMany, "batch_too_large");
  expectReject(validateBatchRequestBody({ requests: [{}], max_in_flight: 0 }), "invalid_max_in_flight");
});

test("批量上限正好卡在 MAX_BATCH_SIZE（100）", () => {
  const exactly = validateBatchRequestBody({ requests: Array.from({ length: MAX_BATCH_SIZE }, () => ({})) });
  assert.equal(exactly.ok, true);
});

// ── 逐項驗證 ────────────────────────────────────────────────

test("inferBatchItemKind：顯式 kind 優先，欄位判別次之，缺省 image", () => {
  assert.equal(inferBatchItemKind({ kind: "video" }), "video");
  assert.equal(inferBatchItemKind({ kind: "image_generate" }), "image");
  assert.equal(inferBatchItemKind({ duration_seconds: 5 }), "video");
  assert.equal(inferBatchItemKind({ generate_audio: true }), "video");
  assert.equal(inferBatchItemKind({ prompt: "x" }), "image");
  assert.equal(inferBatchItemKind({ kind: "audio" }), null);
  assert.equal(inferBatchItemKind({ kind: 123 }), null);
});

test("validateBatchItem 圖片默認值與單任務端點對齊", () => {
  const result = validateBatchItem({ model: IMAGE_MODEL, prompt: " 一隻貓 " }, 0, key);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.kind, "image_generate");
  assert.equal(result.plan.size, "1024x1024");
  assert.equal(result.plan.ratio, "1:1");
  assert.equal(result.plan.quality, "fast");
  assert.equal(result.plan.resolution, "1k");
  assert.equal(result.plan.responseFormat, "b64_json");
  assert.equal(result.plan.routingClass, "generic");
  assert.equal(result.plan.requestedCount, 1);
  assert.equal(result.plan.prompt, "一隻貓");
  assert.equal(result.plan.billingAmount, imageGenerationCoins(IMAGE_MODEL, "fast") * QUOTA_PER_COIN);
});

test("validateBatchItem hd 質量與 firefly 路由對齊", () => {
  const hd = validateBatchItem({ model: IMAGE_MODEL, prompt: "x", quality: "hd", n: 2 }, 0, key);
  assert.equal(hd.ok, true);
  if (hd.ok) {
    assert.equal(hd.plan.quality, "quality");
    assert.equal(hd.plan.resolution, "2k");
    assert.equal(hd.plan.billingAmount, imageGenerationCoins(IMAGE_MODEL, "quality") * QUOTA_PER_COIN * 2);
  }
  const firefly = validateBatchItem({ model: "adobe-firefly", prompt: "x" }, 0, key);
  assert.equal(firefly.ok, true);
  if (firefly.ok) assert.equal(firefly.plan.routingClass, "firefly_only");
});

test("validateBatchItem 視頻項強制 url、走 catalog 歸一化", () => {
  const result = validateBatchItem(
    { kind: "video", model: VIDEO_MODEL, prompt: "x", size: "16:9", duration_seconds: 5 },
    0,
    key,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.kind, "video_generate");
  assert.equal(result.plan.responseFormat, "url");
  assert.equal(result.plan.ratio, "16:9");
  const workflow = result.plan.workflow as { durationSeconds?: number; generateAudio?: boolean } | null;
  assert.equal(
    result.plan.billingAmount,
    generationCoins(VIDEO_MODEL, {
      resolution: result.plan.resolution ?? undefined,
      durationSeconds: workflow?.durationSeconds,
      generateAudio: workflow?.generateAudio,
    }) * QUOTA_PER_COIN,
  );
});

test("validateBatchItem 逐項錯誤碼與單任務端點一致", () => {
  expectReject(validateBatchItem({ model: IMAGE_MODEL }, 0, key), "missing_prompt");
  expectReject(validateBatchItem({ prompt: "x" }, 0, key), "missing_model");
  expectReject(validateBatchItem({ prompt: "x", model: "no-such-model" }, 0, key), "model_not_found");
  expectReject(validateBatchItem({ prompt: "x", model: IMAGE_MODEL, n: 5 }, 0, key), "invalid_n");
  expectReject(validateBatchItem({ prompt: "x", model: IMAGE_MODEL, size: "512x512" }, 0, key), "unsupported_size");
  expectReject(validateBatchItem({ prompt: "x", model: IMAGE_MODEL, kind: "audio" }, 0, key), "invalid_kind");
  expectReject(validateBatchItem("not an object", 0, key), "invalid_item");
});

test("validateBatchItem 金鑰模型白名單逐項拒絕（permission_error）", () => {
  const result = validateBatchItem({ prompt: "x", model: IMAGE_MODEL }, 0, restrictedKey);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "model_not_permitted");
  assert.equal(result.error.type, "permission_error");
});

// ── 冪等 ────────────────────────────────────────────────────

test("batchRequestHash 鍵序無關、內容敏感", () => {
  const left = batchRequestHash([{ model: IMAGE_MODEL, prompt: "a", n: 1 }]);
  const right = batchRequestHash([{ n: 1, prompt: "a", model: IMAGE_MODEL }]);
  assert.equal(left, right);
  const different = batchRequestHash([{ model: IMAGE_MODEL, prompt: "b", n: 1 }]);
  assert.notEqual(left, different);
});

test("batchItemIdempotencyKey 由 batch 與 index 確定性派生", () => {
  assert.equal(batchItemIdempotencyKey("b1", 0), "batch:b1:item:0");
  assert.equal(batchItemIdempotencyKey("b1", 7), "batch:b1:item:7");
});

// ── 聚合數學 ────────────────────────────────────────────────

test("computeBatchAggregate：counts 分桶 + unsubmitted + 金額三桶", () => {
  const batch = fakeBatch({ totalCount: 6 });
  const jobs = [
    fakeJob({ id: "j0", status: "succeeded", billingAmount: 100, batchIndex: 0, finishedAt: new Date() }),
    fakeJob({ id: "j1", status: "failed", billingAmount: 100, batchIndex: 1, failureClass: "empty_result", finishedAt: new Date() }),
    fakeJob({ id: "j2", status: "refunded", billingAmount: 100, batchIndex: 2, finishedAt: new Date() }),
    fakeJob({ id: "j3", status: "running", billingAmount: 100, batchIndex: 3 }),
    fakeJob({ id: "j4", status: "submit_unknown", billingAmount: 100, batchIndex: 4 }),
  ];
  const aggregate = computeBatchAggregate(batch, jobs);
  assert.equal(aggregate.counts.total, 6);
  assert.equal(aggregate.counts.submitted, 5);
  assert.equal(aggregate.counts.unsubmitted, 1);
  assert.equal(aggregate.counts.succeeded, 1);
  assert.equal(aggregate.counts.failed, 1);
  assert.equal(aggregate.counts.refunded, 1);
  assert.equal(aggregate.counts.running, 1);
  assert.equal(aggregate.counts.unknown, 1);
  assert.equal(aggregate.counts.pending, 0);
  assert.equal(aggregate.billing.reserved_total, 500);
  assert.equal(aggregate.billing.charged_total, 100);
  assert.equal(aggregate.billing.refunded_total, 200);
  assert.equal(aggregate.billing.pending_total, 200);
  assert.equal(aggregate.all_terminal, false);
  assert.equal(aggregate.status, "open");
});

test("computeBatchAggregate：全部終結 → completed（未提交項不算在途）", () => {
  const batch = fakeBatch({
    totalCount: 3,
    failedItems: [{ index: 2, code: "missing_prompt", message: "x", type: "invalid_request_error" }],
  });
  const jobs = [
    fakeJob({ id: "j0", status: "succeeded", batchIndex: 0, finishedAt: new Date() }),
    fakeJob({ id: "j1", status: "cancelled", batchIndex: 1, finishedAt: new Date() }),
  ];
  const aggregate = computeBatchAggregate(batch, jobs);
  assert.equal(aggregate.all_terminal, true);
  assert.equal(aggregate.status, "completed");
  assert.equal(aggregate.counts.unsubmitted, 1);
  assert.equal(aggregate.billing.pending_total, 0);
});

test("computeBatchAggregate：全部被拒 → 立即 completed", () => {
  const batch = fakeBatch({ totalCount: 1 });
  const aggregate = computeBatchAggregate(batch, []);
  assert.equal(aggregate.status, "completed");
  assert.equal(aggregate.counts.submitted, 0);
  assert.equal(aggregate.counts.unsubmitted, 1);
});

test("computeBatchAggregate：cancelled 批的判定不被覆寫", () => {
  const batch = fakeBatch({ status: "cancelled" });
  const aggregate = computeBatchAggregate(batch, [fakeJob({ status: "succeeded" })]);
  assert.equal(aggregate.status, "cancelled");
});

test("computeBatchAggregate：billing_unknown / submit_unknown 都歸 unknown 桶", () => {
  const jobs: GenerationJob[] = [
    fakeJob({ status: "billing_unknown" }),
    fakeJob({ status: "submit_unknown" }),
  ];
  const aggregate = computeBatchAggregate(fakeBatch({ totalCount: 2 }), jobs);
  assert.equal(aggregate.counts.unknown, 2);
  assert.equal(aggregate.counts.pending, 0);
  assert.equal(aggregate.counts.running, 0);
});

// ── 逐項視圖 ────────────────────────────────────────────────

test("toBatchItemView：不洩漏密文/workflow/lease；billed 只在 succeeded", () => {
  const view = toBatchItemView(fakeJob({ id: "j0", batchIndex: 2, status: "succeeded", finishedAt: new Date() }));
  assert.equal(view.task_id, "j0");
  assert.equal(view.index, 2);
  assert.equal(view.accepted, true);
  assert.equal(view.billed, true);
  assert.equal(view.task_url, "/v1/images/j0");
  assert.ok(!("promptCiphertext" in view), "不得帶 prompt 密文");
  assert.ok(!("workflow" in view), "不得帶 workflow 內部結構");
  assert.ok(!("leaseOwner" in view), "不得帶租約內部字段");
  const running = toBatchItemView(fakeJob({ status: "running" }));
  assert.equal(running.billed, false);
  const video = toBatchItemView(fakeJob({ kind: "video_generate", id: "v1" }));
  assert.equal(video.task_url, "/v1/videos/v1");
});

test("buildBatchItems：jobs 與拒絕項按 index 合併排序", () => {
  const batch = fakeBatch({
    totalCount: 3,
    failedItems: [
      { index: 0, code: "missing_prompt", message: "缺少必填参数 prompt。", type: "invalid_request_error" },
      { index: 2, code: "stale", message: "已被任務覆蓋，不應出現", type: "invalid_request_error" },
    ],
  });
  const jobs = [
    fakeJob({ id: "j1", batchIndex: 1, status: "succeeded", finishedAt: new Date() }),
    fakeJob({ id: "j2", batchIndex: 2, status: "queued" }),
  ];
  const items = buildBatchItems(batch, jobs);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((item) => item.index), [0, 1, 2]);
  assert.equal(items[0].accepted, false);
  assert.equal(items[0].error?.code, "missing_prompt");
  assert.equal(items[0].task_id, null);
  assert.equal(items[1].task_id, "j1");
  assert.equal(items[2].task_id, "j2");
});

test("computeBatchFailureBreakdown：failure_class 與拒絕碼各計數、按量排序", () => {
  const batch = fakeBatch({
    totalCount: 5,
    failedItems: [
      { index: 3, code: "model_not_found", message: "x", type: "invalid_request_error" },
      { index: 4, code: "model_not_found", message: "x", type: "invalid_request_error" },
    ],
  });
  const jobs = [
    fakeJob({ id: "j0", status: "failed", failureClass: "empty_result", batchIndex: 0 }),
    fakeJob({ id: "j1", status: "failed", failureClass: "empty_result", batchIndex: 1 }),
    fakeJob({ id: "j2", status: "queued", batchIndex: 2 }),
  ];
  const breakdown = computeBatchFailureBreakdown(batch, jobs);
  assert.deepEqual(breakdown, [
    { failure_class: "empty_result", count: 2 },
    { failure_class: "model_not_found", count: 2 },
  ]);
});

test("toBatchReconciliationItem：對賬行帶金額且截斷 failure_detail", () => {
  const longDetail = "x".repeat(500);
  const item = toBatchReconciliationItem(
    fakeJob({ status: "failed", failureClass: "overloaded", failureDetail: longDetail, billingAmount: 77, batchIndex: 4 }),
  );
  assert.equal(item.billing_amount, 77);
  assert.equal(item.billed, false);
  assert.equal(item.failure_class, "overloaded");
  assert.equal(item.failure_detail?.length, 200);
});

test("buildBatchReconciliationItems：拒絕項的金額為 0、帶 error_code", () => {
  const batch = fakeBatch({
    totalCount: 2,
    failedItems: [{ index: 1, code: "invalid_n", message: "x", type: "invalid_request_error" }],
  });
  const jobs = [fakeJob({ id: "j0", batchIndex: 0, status: "succeeded", billingAmount: 50, finishedAt: new Date() })];
  const items = buildBatchReconciliationItems(batch, jobs);
  assert.equal(items.length, 2);
  assert.equal(items[0].billed, true);
  assert.equal(items[0].billing_amount, 50);
  assert.equal(items[1].billing_amount, 0);
  assert.equal(items[1].error_code, "invalid_n");
  assert.equal(items[1].task_id, null);
});

test("狀態全集投影：聚合涵蓋所有內部狀態不漏計", () => {
  const statuses: GenerationJobStatus[] = [
    "pending_billing",
    "billing_unknown",
    "queued",
    "leased",
    "submitting",
    "running",
    "submit_unknown",
    "succeeded",
    "failed",
    "cancelled",
    "refunded",
  ];
  const jobs = statuses.map((status, index) => fakeJob({ id: `j${index}`, status, batchIndex: index }));
  const aggregate = computeBatchAggregate(fakeBatch({ totalCount: statuses.length }), jobs);
  const bucketed =
    aggregate.counts.pending +
    aggregate.counts.running +
    aggregate.counts.succeeded +
    aggregate.counts.failed +
    aggregate.counts.cancelled +
    aggregate.counts.refunded +
    aggregate.counts.unknown;
  assert.equal(bucketed, statuses.length);
});
