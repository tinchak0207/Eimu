// B 端批量生成編排層：POST /v1/batches、GET /v1/batches/:id、
// GET /v1/batches/:id/reconciliation 的資料源。
//
// 鐵律：batch 不建第二套提交/計費/調度——每個 item 都走同一條
// submitGenerationCommand（本模組只產出餵給它的 command 欄位）；鑑權/限流
// 在路由層復用 authenticateBizApiKey / addRateLimitHeaders。
//
// 刻意沿用 status-query.ts 的「純函式 + 可注入 sql」兩半結構：
//  - 純函式（validateBatchRequestBody / validateBatchItem / computeBatchAggregate /
//    buildBatchItems / computeBatchFailureBreakdown / batchRequestHash）不吃 DB，
//    可被單測鎖住 shape 與數學；
//  - 查詢函式接收可注入的 sql，測試只驗證純函式，不留真 DB 依賴。
//
// max_in_flight 是聲明性欄位：可承諾併發由平台 supplier_lease / scheduler
// 的池化併發治理（全量提交 + scheduler 排隊），batch 不自建節流器。

import { randomUUID } from "node:crypto";
import { isModelAllowedForKey, type BizApiKey } from "@/lib/biz-api-keys";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import {
  aspectRatioFromImageSize,
  generationCoins,
  isSupportedImageModel,
  isSupportedVideoModel,
  normalizeGenerationConfig,
  resolveGenerationModelId,
} from "@/lib/generation-model-catalog";
import { ADOBE_FIREFLY_MODEL_ID, imageGenerationCoins } from "@/lib/provider-config";
import { MAX_CONTROL_NETS, normalizeControlNets, toPixaiControlNets } from "@/lib/pixai-controlnets";
import { generationRequestHash } from "./crypto";
import { getGenerationSql, type GenerationSql } from "./database";
import { mapGenerationJob } from "./job-repository";
import { taskStatus } from "./task-response";
import { MAX_REQUEST_BATCH_COUNT } from "./request-limits";
import type { GenerationJob, GenerationJobStatus, GenerationWorkflow } from "./types";

// ─────────────────────────────────────────── 常量（可調）

/** 單批上限。日萬級任務 = 多批提交；上限是常量，需要時上調即可。 */
export const MAX_BATCH_SIZE = 100;
/** max_in_flight 的合法區間上限（聲明性欄位，實際併發由平台治理）。 */
export const MAX_IN_FLIGHT_LIMIT = 1_000;
/** 與 /v1/images/generations、/v1/videos/generations 逐項對齊的約束。 */
export const MAX_BATCH_ITEM_PROMPT_LENGTH = 4_000;
/** 逐項 `n` 上限＝單點常數（request-limits.ts），與 `/v1/models` 的
 *  `x_capabilities.maxBatchCount` 同一顆（D23：揭露值＝擋人值）。 */
export const MAX_BATCH_ITEM_N = MAX_REQUEST_BATCH_COUNT;
/** 與 /v1/images/generations 的 SUPPORTED_SIZES 對齊（上游只接受這三種）。 */
const BATCH_IMAGE_SIZES = new Set(["1024x1024", "1536x1024", "1024x1536"]);

// ─────────────────────────────────────────── 純邏輯（可單測，不吃 DB）

/** 對外錯誤體：與既有 error.type/code/param 形狀對齊（trace_id 由路由補）。 */
export interface BatchItemErrorBody {
  message: string;
  type: "invalid_request_error" | "permission_error" | "api_error";
  code: string;
  param: string | null;
}

/** 通過逐項驗證、可直接餵給 submitGenerationCommand 的 item 計畫。 */
export interface BatchItemPlan {
  index: number;
  kind: "image_generate" | "video_generate";
  routingClass: "generic" | "firefly_only" | "hub_only";
  modelId: string;
  prompt: string;
  size: string | null;
  ratio: string | null;
  resolution: string | null;
  quality: string | null;
  workflow: GenerationWorkflow | null;
  responseFormat: "b64_json" | "url";
  callbackUrl: string | null;
  requestedCount: number;
  billingAmount: number;
}

export type BatchItemValidation =
  | { ok: true; plan: BatchItemPlan }
  | { ok: false; error: BatchItemErrorBody };

function itemError(
  message: string,
  code: string,
  type: BatchItemErrorBody["type"] = "invalid_request_error",
): { ok: false; error: BatchItemErrorBody } {
  return { ok: false, error: { message, type, code, param: null } };
}

/** size 參數：兼容 "16:9" 與 "1920x1080" 兩種寫法（與 /v1/videos/generations 同規則）。 */
function aspectRatioFromVideoSize(size?: string): string | undefined {
  if (!size) return undefined;
  if (/^\d+x\d+$/.test(size)) return aspectRatioFromImageSize(size);
  if (size.includes(":")) return size;
  return undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return undefined;
}

/** kind 判別：顯式 kind 優先；無 kind 時由影片專屬欄位判別，否則視為圖片。 */
export function inferBatchItemKind(raw: Record<string, unknown>): "image" | "video" | null {
  if (raw.kind !== undefined) {
    if (typeof raw.kind !== "string") return null;
    const normalized = raw.kind.trim().toLowerCase();
    if (["image", "images", "image_generate"].includes(normalized)) return "image";
    if (["video", "videos", "video_generate"].includes(normalized)) return "video";
    return null;
  }
  if (raw.duration_seconds !== undefined || raw.generate_audio !== undefined) return "video";
  return "image";
}

/**
 * 逐項驗證：對齊 /v1/images/generations 與 /v1/videos/generations 的欄位規則。
 * 單項失敗不炸整批——呼叫方把 error 逐項回給客戶。
 */
export function validateBatchItem(raw: unknown, index: number, apiKey: Pick<BizApiKey, "allowedModels">): BatchItemValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return itemError("批量項必須是物件。", "invalid_item");
  }
  const item = raw as Record<string, unknown>;
  const kind = inferBatchItemKind(item);
  if (!kind) return itemError("kind 需为 image 或 video。", "invalid_kind");

  const prompt = typeof item.prompt === "string" ? item.prompt.trim() : "";
  if (!prompt) return itemError("缺少必填参数 prompt。", "missing_prompt");
  if (prompt.length > MAX_BATCH_ITEM_PROMPT_LENGTH) {
    return itemError("prompt 长度不能超过 " + MAX_BATCH_ITEM_PROMPT_LENGTH + " 个字符。", "prompt_too_long");
  }

  const rawModelId = typeof item.model === "string" && item.model ? item.model : "";
  if (!rawModelId) return itemError("缺少必填参数 model。", "missing_model");
  // 宽容解析：与單任務端點同一套顯示名歸一（如 "seedream 2.0" → seedance 風格 id）。
  const modelId = resolveGenerationModelId(rawModelId) ?? rawModelId;

  if (kind === "image" && !isSupportedImageModel(modelId)) {
    return itemError("不支持的模型 " + modelId + "。可用模型请调用 GET /v1/models。", "model_not_found");
  }
  if (kind === "video" && !isSupportedVideoModel(modelId)) {
    return itemError("不支持的视频模型 " + modelId + "。可用模型请调用 GET /v1/models。", "model_not_found");
  }
  if (!isModelAllowedForKey(apiKey, modelId)) {
    return itemError("当前密钥无权调用模型 " + modelId + "。", "model_not_permitted", "permission_error");
  }

  const rawN = item.n === undefined ? 1 : Number(item.n);
  if (!Number.isInteger(rawN) || rawN < 1 || rawN > MAX_BATCH_ITEM_N) {
    return itemError("n 需为 1 到 " + MAX_BATCH_ITEM_N + " 之间的整数。", "invalid_n");
  }

  const callbackUrl = typeof item.callback_url === "string" && item.callback_url.trim()
    ? item.callback_url.trim()
    : null;

  if (kind === "image") {
    const size = typeof item.size === "string" && item.size ? item.size : "1024x1024";
    if (!BATCH_IMAGE_SIZES.has(size)) {
      return itemError("不支持的 size " + size + "。可选：" + [...BATCH_IMAGE_SIZES].join("、") + "。", "unsupported_size");
    }
    const qualityMode = item.quality === "hd" || item.quality === "high" ? "quality" : "fast";
    const responseFormat = item.response_format === "url" ? "url" : "b64_json";

    // ControlNet：與 /v1/images/generations 同一套清洗規則，非法形狀逐項拒絕。
    let workflow: GenerationWorkflow | null = null;
    if (item.control_nets !== undefined) {
      const normalized = normalizeControlNets(item.control_nets);
      if (normalized.valid.length === 0 || normalized.rejected.length > 0) {
        return itemError(
          "control_nets 需为最多 " + MAX_CONTROL_NETS + " 项的数组，每项需含 image（参考图 mediaId 或 URL）与 type（如 canny/depth/openpose）。",
          "invalid_control_nets",
        );
      }
      workflow = { metadata: { controlNets: toPixaiControlNets(normalized.valid) } };
    }

    return {
      ok: true,
      plan: {
        index,
        kind: "image_generate",
        routingClass: modelId === ADOBE_FIREFLY_MODEL_ID ? "firefly_only" : "generic",
        modelId,
        prompt,
        size,
        ratio: aspectRatioFromImageSize(size),
        resolution: qualityMode === "quality" ? "2k" : "1k",
        quality: qualityMode,
        workflow,
        responseFormat,
        callbackUrl,
        requestedCount: rawN,
        billingAmount: imageGenerationCoins(modelId, qualityMode) * QUOTA_PER_COIN * rawN,
      },
    };
  }

  // video：時長/音訊/寬高比交給 catalog 歸一化（非法值回默認，合法值透傳）。
  const normalized = normalizeGenerationConfig(modelId, {
    aspectRatio: aspectRatioFromVideoSize(typeof item.size === "string" ? item.size : undefined),
    durationSeconds: item.duration_seconds === undefined ? undefined : Number(item.duration_seconds),
    generateAudio: optionalBoolean(item.generate_audio),
  });
  return {
    ok: true,
    plan: {
      index,
      kind: "video_generate",
      routingClass: "generic",
      modelId,
      prompt,
      size: null,
      ratio: normalized.config.aspectRatio,
      resolution: normalized.config.outputResolution,
      quality: normalized.config.qualityMode,
      workflow: {
        durationSeconds: normalized.config.durationSeconds,
        generateAudio: normalized.config.generateAudio,
      },
      // 影片上游只返回 URL（無 b64 通道），與 /v1/videos/generations 一致強制 url。
      responseFormat: "url",
      callbackUrl,
      requestedCount: rawN,
      billingAmount: generationCoins(modelId, {
        resolution: normalized.config.outputResolution,
        durationSeconds: normalized.config.durationSeconds,
        generateAudio: normalized.config.generateAudio,
      }) * QUOTA_PER_COIN * rawN,
    },
  };
}

export type BatchRequestBodyValidation =
  | { ok: true; requests: unknown[]; maxInFlight: number | null }
  | { ok: false; message: string; code: string };

/** 批級結構驗證：requests 形狀與批量上限（超限整批 4xx，明確錯誤碼）。 */
export function validateBatchRequestBody(body: unknown): BatchRequestBodyValidation {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "请求体格式不正确。", code: "invalid_request_body" };
  }
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.requests)) {
    return { ok: false, message: "requests 需为任务数组。", code: "missing_requests" };
  }
  if (raw.requests.length === 0) {
    return { ok: false, message: "requests 不能为空。", code: "empty_requests" };
  }
  if (raw.requests.length > MAX_BATCH_SIZE) {
    return {
      ok: false,
      message: "批量上限为 " + MAX_BATCH_SIZE + " 个任务，当前 " + raw.requests.length + " 个。请拆分为多个批次提交。",
      code: "batch_too_large",
    };
  }
  let maxInFlight: number | null = null;
  if (raw.max_in_flight !== undefined && raw.max_in_flight !== null) {
    const parsed = Number(raw.max_in_flight);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_IN_FLIGHT_LIMIT) {
      return {
        ok: false,
        message: "max_in_flight 需为 1 到 " + MAX_IN_FLIGHT_LIMIT + " 之间的整数（声明性字段，实际并发由平台治理）。",
        code: "invalid_max_in_flight",
      };
    }
    maxInFlight = parsed;
  }
  return { ok: true, requests: raw.requests, maxInFlight };
}

/** 批級請求雜湊：規範化（鍵序無關）後取 sha256，冪等重放比對用。 */
export function batchRequestHash(requests: unknown[]): string {
  return generationRequestHash({ requests });
}

/** 批內 item 的確定性冪等鍵：崩潰後重放同一批時，已提交項不會重複建任務/扣費。 */
export function batchItemIdempotencyKey(batchId: string, index: number): string {
  return "batch:" + batchId + ":item:" + index;
}

// ─────────────────────────────────────────── 批記錄與聚合（純邏輯）

export interface BatchFailedItemRecord {
  index: number;
  code: string;
  message: string;
  type: string;
}

export interface GenerationBatch {
  id: string;
  tenantId: string;
  status: "open" | "completed" | "cancelled";
  totalCount: number;
  maxInFlight: number | null;
  idempotencyKey: string | null;
  requestHash: string;
  failedItems: BatchFailedItemRecord[];
  createdAt: Date;
  completedAt: Date | null;
  updatedAt: Date;
}

type Row = Record<string, unknown>;

function jsonValue<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function nullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : value instanceof Date ? value : new Date(String(value));
}

export function mapGenerationBatch(row: Row): GenerationBatch {
  const status = row.status === "completed" || row.status === "cancelled" ? row.status : "open";
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    status,
    totalCount: Number(row.total_count),
    maxInFlight: row.max_in_flight === null || row.max_in_flight === undefined ? null : Number(row.max_in_flight),
    idempotencyKey: row.idempotency_key === null || row.idempotency_key === undefined ? null : String(row.idempotency_key),
    requestHash: String(row.request_hash),
    failedItems: jsonValue<BatchFailedItemRecord[]>(row.failed_items_json, []),
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(String(row.created_at)),
    completedAt: nullableDate(row.completed_at),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt : new Date(String(row.updated_at)),
  };
}

/** 終結投影（taskStatus 的輸出）：對賬與「批是否做完」的判定基準。 */
const TERMINAL_TASK_STATES: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled", "refunded"]);

export interface BatchStatusCounts {
  total: number;
  submitted: number;
  /** total - submitted：驗證/提交失敗、永遠不會變成任務的項。 */
  unsubmitted: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  refunded: number;
  unknown: number;
}

export interface BatchBillingSummary {
  /** 全部已提交項的預留金額合計。 */
  reserved_total: number;
  /** 成功項計費合計（失敗退費=按成功計費，只有 succeeded 真正落賬）。 */
  charged_total: number;
  /** 已終結且未成功項的退回合計。 */
  refunded_total: number;
  /** 尚未終結項的預留（在途）合計。 */
  pending_total: number;
}

export interface BatchAggregate {
  status: "open" | "completed" | "cancelled";
  counts: BatchStatusCounts;
  billing: BatchBillingSummary;
  /** 全部已提交項都終結（部分成功語義：succeeded 項隨時可經 /v1/images/:id/result 取件）。 */
  all_terminal: boolean;
}

/**
 * 聚合視圖數學：counts 按 OpenAI 相容投影（task_state）分桶；
 * billing 以 job.billingAmount 為準——reserve 發生在提交時、成功 commit、
 * 失敗 refund，因此 charged = succeeded 項合計，refunded = 非成功終結項合計。
 */
export function computeBatchAggregate(batch: GenerationBatch, jobs: GenerationJob[]): BatchAggregate {
  const counts: BatchStatusCounts = {
    total: batch.totalCount,
    submitted: jobs.length,
    unsubmitted: Math.max(0, batch.totalCount - jobs.length),
    pending: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    refunded: 0,
    unknown: 0,
  };
  let reserved = 0;
  let charged = 0;
  let refunded = 0;
  let pending = 0;
  for (const job of jobs) {
    const state = taskStatus(job);
    reserved += job.billingAmount;
    if (state === "queued") counts.pending += 1;
    else if (state === "running") counts.running += 1;
    else if (state === "succeeded") counts.succeeded += 1;
    else if (state === "failed") counts.failed += 1;
    else if (state === "cancelled") counts.cancelled += 1;
    else if (state === "refunded") counts.refunded += 1;
    else counts.unknown += 1;

    if (state === "succeeded") charged += job.billingAmount;
    else if (TERMINAL_TASK_STATES.has(state)) refunded += job.billingAmount;
    else pending += job.billingAmount;
  }
  // 未提交項（驗證失敗）從未預留金額，不進任何金額桶。
  const allTerminal = jobs.every((job) => TERMINAL_TASK_STATES.has(taskStatus(job)));
  return {
    status: batch.status === "cancelled" ? "cancelled" : allTerminal ? "completed" : "open",
    counts,
    billing: {
      reserved_total: reserved,
      charged_total: charged,
      refunded_total: refunded,
      pending_total: pending,
    },
    all_terminal: allTerminal,
  };
}

/** 批視圖的逐項卡片：已提交項帶任務快照，未提交項帶當時的拒絕原因。 */
export interface BatchItemView {
  index: number;
  accepted: boolean;
  task_id: string | null;
  task_url: string | null;
  status: GenerationJobStatus | null;
  task_state: string | null;
  model: string | null;
  kind: string | null;
  /** 成功才計費：只有 succeeded 為 true。 */
  billed: boolean;
  failure_class: string | null;
  failure_detail: string | null;
  error: BatchItemErrorBody | null;
  created_at: string | null;
  finished_at: string | null;
}

export function toBatchItemView(job: GenerationJob): BatchItemView {
  const state = taskStatus(job);
  const kindPath = job.kind === "video_generate" ? "videos" : "images";
  return {
    index: job.batchIndex ?? 0,
    accepted: true,
    task_id: job.id,
    task_url: "/v1/" + kindPath + "/" + job.id,
    status: job.status,
    task_state: state,
    model: job.modelId,
    kind: job.kind,
    billed: state === "succeeded",
    failure_class: job.failureClass,
    failure_detail: job.failureDetail,
    error: null,
    created_at: job.createdAt.toISOString(),
    finished_at: job.finishedAt ? job.finishedAt.toISOString() : null,
  };
}

function toRejectedBatchItemView(failed: BatchFailedItemRecord): BatchItemView {
  return {
    index: failed.index,
    accepted: false,
    task_id: null,
    task_url: null,
    status: null,
    task_state: null,
    model: null,
    kind: null,
    billed: false,
    failure_class: null,
    failure_detail: null,
    error: {
      message: failed.message,
      type: failed.type === "permission_error" || failed.type === "api_error" ? failed.type : "invalid_request_error",
      code: failed.code,
      param: null,
    },
    created_at: null,
    finished_at: null,
  };
}

/** 批內逐項視圖（按 index 升序）：jobs + 沒有對應 job 的拒絕項快照。 */
export function buildBatchItems(batch: GenerationBatch, jobs: GenerationJob[]): BatchItemView[] {
  const items: BatchItemView[] = jobs.map(toBatchItemView);
  const submittedIndexes = new Set(jobs.map((job) => job.batchIndex));
  for (const failed of batch.failedItems) {
    if (submittedIndexes.has(failed.index)) continue;
    items.push(toRejectedBatchItemView(failed));
  }
  return items.sort((left, right) => left.index - right.index);
}

/** 對賬的失敗原因分佈：job 的 failure_class + 未提交項的驗證錯誤碼，各計數。 */
export interface BatchFailureBreakdownItem {
  failure_class: string;
  count: number;
}

export function computeBatchFailureBreakdown(batch: GenerationBatch, jobs: GenerationJob[]): BatchFailureBreakdownItem[] {
  const counts = new Map<string, number>();
  for (const job of jobs) {
    if (!job.failureClass) continue;
    counts.set(job.failureClass, (counts.get(job.failureClass) ?? 0) + 1);
  }
  const submittedIndexes = new Set(jobs.map((job) => job.batchIndex));
  for (const failed of batch.failedItems) {
    if (submittedIndexes.has(failed.index)) continue;
    counts.set(failed.code, (counts.get(failed.code) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([failure_class, count]) => ({ failure_class, count }))
    .sort((left, right) => right.count - left.count || left.failure_class.localeCompare(right.failure_class));
}

/** 對賬逐項行：含計費金額（對賬端點專用；診斷面仍不帶計費字段）。 */
export interface BatchReconciliationItem {
  index: number;
  task_id: string | null;
  model: string | null;
  kind: string | null;
  status: GenerationJobStatus | null;
  task_state: string | null;
  billed: boolean;
  billing_amount: number;
  failure_class: string | null;
  /** 截斷到 200 字符：對賬要原因分類，不要整段上游噪聲。 */
  failure_detail: string | null;
  error_code: string | null;
  created_at: string | null;
  finished_at: string | null;
}

export function toBatchReconciliationItem(job: GenerationJob): BatchReconciliationItem {
  const state = taskStatus(job);
  return {
    index: job.batchIndex ?? 0,
    task_id: job.id,
    model: job.modelId,
    kind: job.kind,
    status: job.status,
    task_state: state,
    billed: state === "succeeded",
    billing_amount: job.billingAmount,
    failure_class: job.failureClass,
    failure_detail: job.failureDetail ? job.failureDetail.slice(0, 200) : null,
    error_code: null,
    created_at: job.createdAt.toISOString(),
    finished_at: job.finishedAt ? job.finishedAt.toISOString() : null,
  };
}

export function buildBatchReconciliationItems(batch: GenerationBatch, jobs: GenerationJob[]): BatchReconciliationItem[] {
  const items: BatchReconciliationItem[] = jobs.map(toBatchReconciliationItem);
  const submittedIndexes = new Set(jobs.map((job) => job.batchIndex));
  for (const failed of batch.failedItems) {
    if (submittedIndexes.has(failed.index)) continue;
    items.push({
      index: failed.index,
      task_id: null,
      model: null,
      kind: null,
      status: null,
      task_state: null,
      billed: false,
      billing_amount: 0,
      failure_class: null,
      failure_detail: null,
      error_code: failed.code,
      created_at: null,
      finished_at: null,
    });
  }
  return items.sort((left, right) => left.index - right.index);
}

// ─────────────────────────────────────────── 查詢層（sql 可注入）

export class BatchIdempotencyConflictError extends Error {
  constructor(readonly batchId: string) {
    super("The Idempotency-Key was already used with a different batch request.");
    this.name = "BatchIdempotencyConflictError";
  }
}

export interface CreateGenerationBatchInput {
  id?: string;
  tenantId: string;
  totalCount: number;
  maxInFlight: number | null;
  idempotencyKey: string | null;
  requestHash: string;
}

/**
 * 冪等建立批記錄：與 createGenerationJob 同一套 ON CONFLICT 模式。
 * 重放（同一 tenant + 同一 Idempotency-Key）回同一批；內容雜湊不同則 409。
 */
export async function createGenerationBatch(
  input: CreateGenerationBatchInput,
  sql: GenerationSql = getGenerationSql(),
): Promise<{ batch: GenerationBatch; created: boolean }> {
  const rows = await sql<Row[]>`
    INSERT INTO generation_batches (id, tenant_id, status, total_count, max_in_flight, idempotency_key, request_hash)
    VALUES (${input.id ?? randomUUID()}, ${input.tenantId}, 'open', ${input.totalCount}, ${input.maxInFlight}, ${input.idempotencyKey ?? null}, ${input.requestHash})
    ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING *
  `;
  if (rows[0]) return { batch: mapGenerationBatch(rows[0]), created: true };

  if (!input.idempotencyKey) throw new Error("Generation batch insert failed.");
  const existing = await sql<Row[]>`
    SELECT * FROM generation_batches
    WHERE tenant_id = ${input.tenantId} AND idempotency_key = ${input.idempotencyKey}
    LIMIT 1
  `;
  if (!existing[0]) throw new Error("Idempotent generation batch disappeared after conflict.");
  if (String(existing[0].request_hash) !== input.requestHash) {
    throw new BatchIdempotencyConflictError(String(existing[0].id));
  }
  return { batch: mapGenerationBatch(existing[0]), created: false };
}

export async function getGenerationBatchForTenant(
  id: string,
  tenantId: string,
  sql: GenerationSql = getGenerationSql(),
): Promise<GenerationBatch | null> {
  const rows = await sql<Row[]>`
    SELECT * FROM generation_batches WHERE id = ${id} AND tenant_id = ${tenantId} LIMIT 1
  `;
  return rows[0] ? mapGenerationBatch(rows[0]) : null;
}

export async function listGenerationBatchJobs(
  batchId: string,
  sql: GenerationSql = getGenerationSql(),
): Promise<GenerationJob[]> {
  const rows = await sql<Row[]>`
    SELECT * FROM generation_job
    WHERE batch_id = ${batchId}
    ORDER BY batch_index ASC NULLS LAST, created_at ASC
  `;
  return rows.map(mapGenerationJob);
}

/** 逐項驗證/提交失敗快照落盤（冪等重放時以最新一次的驗證結果覆寫）。 */
export async function recordGenerationBatchFailedItems(
  batchId: string,
  failedItems: BatchFailedItemRecord[],
  sql: GenerationSql = getGenerationSql(),
): Promise<void> {
  await sql`
    UPDATE generation_batches
    SET failed_items_json = ${sql.json(JSON.parse(JSON.stringify(failedItems)) as never)}, updated_at = now()
    WHERE id = ${batchId}
  `;
}

/**
 * 讀取時惰性收斂批狀態：全部已提交項終結 → completed（寫入 completed_at）。
 * 批本身不參與任務狀態機，這是編排層唯一的狀態寫入。
 */
export async function finalizeGenerationBatchIfTerminal(
  batch: GenerationBatch,
  jobs: GenerationJob[],
  sql: GenerationSql = getGenerationSql(),
): Promise<GenerationBatch> {
  if (batch.status !== "open" || !computeBatchAggregate(batch, jobs).all_terminal) return batch;
  const rows = await sql<Row[]>`
    UPDATE generation_batches
    SET status = 'completed', completed_at = COALESCE(completed_at, now()), updated_at = now()
    WHERE id = ${batch.id} AND status = 'open'
    RETURNING *
  `;
  return rows[0] ? mapGenerationBatch(rows[0]) : batch;
}
