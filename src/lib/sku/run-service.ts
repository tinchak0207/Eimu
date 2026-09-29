// SKU run 編排服務：run_id 管理、可插拔發射器、run 聚合查詢與視圖構建。
//
// 鐵律：不自建第二套提交/計費/鑑權——每個鏡頭都走同一條 submitGenerationCommand
// （冪等鍵逐鏡頭生成），鑑權/限流在路由層復用既有 biz-api 模式。
//
// run 的狀態存儲論證（為什麼「無狀態優先」成立）：
// run_id 不落新表——它就是冪等鍵根。每個鏡頭任務帶確定性冪等鍵
// skurun:<run_id>:<shot_index>，落在既有 generation_job.idempotency_key 上；
// GET /v1/skus/runs/:id 用前綴查詢把 run 的任務撈回來聚合。零新遷移、零新表，
// 任務本身就是 run 的唯一事實源（提交/計費/狀態全在 job 上）。量級大了再加
// 專用索引或 runs 表（見 docs TODO）。

import { randomUUID } from "node:crypto";
import { ADOBE_FIREFLY_MODEL_ID, imageGenerationCoins } from "@/lib/provider-config";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import { generationCoins, imageSizeForAspectRatio, type AspectRatio } from "@/lib/generation-model-catalog";
import type { GenerationJob, GenerationWorkflow } from "@/lib/generation-core/types";
import { submitGenerationCommand } from "@/lib/generation-core/command-service";
import { IdempotencyConflictError, mapGenerationJob } from "@/lib/generation-core/job-repository";
import { GenerationModelUnavailableError } from "@/lib/generation-core/model-availability-gate";
import {
  computeBatchAggregate,
  type GenerationBatch,
} from "@/lib/generation-core/batch-service";
import { taskStatus } from "@/lib/generation-core/task-response";
import { getGenerationSql, type GenerationSql } from "@/lib/generation-core/database";
import type { ExpandedSkuShot, MarketingSku } from "./types";

// ─────────────────────────────────────────── 常量

/** run 冪等鍵前綴；與 /v1/batches 的 "batch:" 前綴命名空間互不重疊。 */
export const SKU_RUN_KEY_PREFIX = "skurun";
/** 單次請求最多展開幾個 run（表格批量場景的上限）。 */
export const MAX_RUNS_PER_REQUEST = 10;
/** 單個 run 的鏡頭數上限（現有 SKU 最高 8；留餘量給未來 SKU）。 */
export const MAX_SHOTS_PER_RUN = 12;
/** run_id 字符集：字母數字開頭，允許連字號/下劃線（冪等鍵與 LIKE 查詢都安全）。 */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

/** 客戶自帶 run_id（或 Idempotency-Key）的合法性檢查。 */
export function normalizeRunId(raw: unknown): { ok: true; runId: string } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: false, message: "run_id / Idempotency-Key 需為字符串。" };
  const trimmed = raw.trim();
  if (!RUN_ID_PATTERN.test(trimmed)) {
    return { ok: false, message: "run_id 需為 8-128 位字母數字開頭的字符串（可含連字號/下劃線）。" };
  }
  return { ok: true, runId: trimmed };
}

/** 生成新 run_id（客戶未帶 Idempotency-Key 時）。 */
export function generateRunId(): string {
  return "skurun_" + randomUUID();
}

/** 單鏡頭的確定性冪等鍵：崩潰後重放同一 run 時，已提交鏡頭不會重複建任務/扣費。 */
export function skuRunIdempotencyKey(runId: string, shotIndex: number): string {
  return SKU_RUN_KEY_PREFIX + ":" + runId + ":" + shotIndex;
}

/** 從冪等鍵反解鏡頭序號；非本層鍵回 null。 */
export function shotIndexFromIdempotencyKey(key: string | null): number | null {
  if (!key) return null;
  const match = new RegExp("^" + SKU_RUN_KEY_PREFIX + ":(.+):(\\d+)$").exec(key);
  if (!match) return null;
  const index = Number(match[2]);
  return Number.isInteger(index) ? index : null;
}

// ─────────────────────────────────────────── 鏡頭 → 提交計劃

export interface SkuShotCommandPlan {
  runId: string;
  shotIndex: number;
  shotId: string;
  kind: "image_generate" | "video_generate";
  routingClass: "generic" | "firefly_only";
  modelId: string;
  prompt: string;
  size: string | null;
  ratio: string | null;
  resolution: string | null;
  quality: string | null;
  workflow: GenerationWorkflow;
  responseFormat: "b64_json" | "url";
  callbackUrl: string | null;
  requestedCount: number;
  billingAmount: number;
}

export interface SkuRunPlanOptions {
  runId: string;
  modelId: string;
  callbackUrl?: string | null;
  /** 可選：附加進 workflow 元數據的輸入線索（如 product_image_url，v1 僅記錄）。 */
  extraMetadata?: Record<string, unknown>;
}

/** 把展開後的鏡頭計劃轉成 submitGenerationCommand 的輸入形狀（純函數，可單測）。 */
export function buildSkuShotCommandPlans(
  sku: MarketingSku,
  shots: ExpandedSkuShot[],
  options: SkuRunPlanOptions,
): SkuShotCommandPlan[] {
  return shots.map((shot) => {
    const isVideo = shot.kind === "video";
    const quality = shot.resolution === "2k" || shot.resolution === "4k" ? "quality" : "fast";
    const billingAmount = isVideo
      ? generationCoins(options.modelId, {
          resolution: shot.resolution,
          durationSeconds: shot.durationSeconds,
        }) * QUOTA_PER_COIN
      : imageGenerationCoins(options.modelId, quality, shot.resolution) * QUOTA_PER_COIN;
    const workflow: GenerationWorkflow = {
      metadata: {
        sku: {
          skuId: sku.id,
          runId: options.runId,
          shotIndex: shot.index,
          shotId: shot.shotId,
          ...(options.extraMetadata ? options.extraMetadata : {}),
        },
      },
    };
    return {
      runId: options.runId,
      shotIndex: shot.index,
      shotId: shot.shotId,
      kind: isVideo ? "video_generate" : "image_generate",
      routingClass: options.modelId === ADOBE_FIREFLY_MODEL_ID ? "firefly_only" : "generic",
      modelId: options.modelId,
      prompt: shot.prompt,
      size: isVideo ? null : imageSizeForAspectRatio(shot.aspectRatio as AspectRatio),
      ratio: shot.aspectRatio,
      resolution: shot.resolution,
      quality,
      workflow,
      responseFormat: "url",
      callbackUrl: options.callbackUrl ?? null,
      requestedCount: 1,
      billingAmount: Math.round(billingAmount),
    };
  });
}

// ─────────────────────────────────────────── 可插拔發射器

export interface SkuDispatchContext {
  tenantId: string;
  apiKeyId: string;
  billingUserId: number;
}

export interface SkuDispatchOutcome {
  shotIndex: number;
  accepted: boolean;
  taskId: string | null;
  /** true = 冪等重放命中既有任務（未重複建任務/扣費）。 */
  replayed?: boolean;
  error?: { message: string; type: "invalid_request_error" | "api_error"; code: string; param: null };
}

/**
 * 發射器接口：把一個 run 的全部鏡頭計劃提交出去。
 * 默認實現 = 單任務循環（submitGenerationCommand 逐項、冪等鍵逐項）；
 * /v1/batches 批量端點就緒後，加一個 batch 實現並在 resolveSkuDispatcher
 * 一行切換——SKU 層其他代碼不動。
 */
export interface SkuDispatcher {
  submitAll(plans: SkuShotCommandPlan[], context: SkuDispatchContext): Promise<SkuDispatchOutcome[]>;
}

export function createLoopSkuDispatcher(): SkuDispatcher {
  return {
    async submitAll(plans, context) {
      const outcomes: SkuDispatchOutcome[] = [];
      for (const plan of plans) {
        try {
          const submitted = await submitGenerationCommand({
            tenantId: context.tenantId,
            apiKeyId: context.apiKeyId,
            billingUserId: context.billingUserId,
            source: "biz",
            idempotencyKey: skuRunIdempotencyKey(plan.runId, plan.shotIndex),
            kind: plan.kind,
            routingClass: plan.routingClass,
            modelId: plan.modelId,
            prompt: plan.prompt,
            size: plan.size,
            ratio: plan.ratio,
            resolution: plan.resolution,
            quality: plan.quality,
            workflow: plan.workflow,
            responseFormat: plan.responseFormat,
            callbackUrl: plan.callbackUrl,
            requestedCount: plan.requestedCount,
            billingAmount: plan.billingAmount,
          });
          outcomes.push({
            shotIndex: plan.shotIndex,
            accepted: true,
            taskId: submitted.job.id,
            replayed: !submitted.created,
          });
        } catch (error) {
          if (error instanceof IdempotencyConflictError) {
            outcomes.push({
              shotIndex: plan.shotIndex,
              accepted: false,
              taskId: null,
              error: {
                message: "该镜头的幂等键已被不同请求占用（run_id 重放时输入或 model 覆盖变了）。",
                type: "invalid_request_error",
                code: "idempotency_key_reused",
                param: null,
              },
            });
            continue;
          }
          // 模型可用性閘：該鏡頭建單/扣費前拒絕，誠實回報（不假裝提交）。
          if (error instanceof GenerationModelUnavailableError) {
            outcomes.push({
              shotIndex: plan.shotIndex,
              accepted: false,
              taskId: null,
              error: { message: error.message, type: "api_error", code: "no_endpoints", param: null },
            });
            continue;
          }
          console.error("[sku-run] shot submission failed", {
            runId: plan.runId,
            shotIndex: plan.shotIndex,
            skuId: plan.shotId,
            error,
          });
          outcomes.push({
            shotIndex: plan.shotIndex,
            accepted: false,
            taskId: null,
            error: {
              message: "镜头任务提交失败，请用同一 run_id 重放以补齐缺失镜头。",
              type: "api_error",
              code: "submission_failed",
              param: null,
            },
          });
        }
      }
      return outcomes;
    },
  };
}

/**
 * 發射器解析（切換點）：SKU_RUN_DISPATCHER=loop（默認）。
 * batch 值保留給「經 /v1/batches 批量端點發射」的實現——接入時在這裡返回
 * batch dispatcher 即可，路由層與展開層零改動。
 */
export function resolveSkuDispatcher(env: NodeJS.ProcessEnv = process.env): SkuDispatcher {
  const mode = env.SKU_RUN_DISPATCHER?.trim().toLowerCase() ?? "loop";
  if (mode !== "loop") {
    console.warn("[sku-run] SKU_RUN_DISPATCHER=" + mode + " 尚未接入，回退 loop 發射器。");
  }
  return createLoopSkuDispatcher();
}

// ─────────────────────────────────────────── run 聚合查詢（無狀態）

type JobRow = Record<string, unknown>;

/**
 * 撈回一個 run 的全部鏡頭任務：按冪等鍵前綴（skurun:<run_id>:*）查既有
 * generation_job 表。run 不落新表——任務本身就是事實源。
 */
export async function getSkuRunJobs(
  runId: string,
  tenantId: string,
  sql: GenerationSql = getGenerationSql(),
): Promise<GenerationJob[]> {
  const rows = await sql<JobRow[]>`
    SELECT * FROM generation_job
    WHERE tenant_id = \${tenantId}
      AND idempotency_key LIKE (\${SKU_RUN_KEY_PREFIX + ":" + runId + ":%"})
    ORDER BY idempotency_key ASC
  `;
  const jobs = rows.map(mapGenerationJob);
  // 冪等鍵字典序在 shot_index >= 10 時錯序（…:10 排在 …:2 前），按解析出的序號重排。
  return jobs.sort((left, right) => {
    const a = shotIndexFromIdempotencyKey(left.idempotencyKey) ?? 0;
    const b = shotIndexFromIdempotencyKey(right.idempotencyKey) ?? 0;
    return a - b;
  });
}

// ─────────────────────────────────────────── 視圖構建（純函數，可單測）

/** 從 job 的 workflow 元數據裡取 SKU 回填信息。 */
function skuMetadata(job: GenerationJob): Record<string, unknown> {
  const metadata = (job.workflow as { metadata?: { sku?: Record<string, unknown> } })?.metadata;
  return metadata?.sku ?? {};
}

export interface SkuRunItemView {
  shot_index: number;
  shot_id: string | null;
  task_id: string;
  task_url: string;
  status: string;
  task_state: string;
  model: string;
  kind: string;
  billed: boolean;
  billing_amount: number;
  failure_class: string | null;
  failure_detail: string | null;
  result_url: string | null;
  created_at: string;
  finished_at: string | null;
}

export function toSkuRunItemView(job: GenerationJob): SkuRunItemView {
  const state = taskStatus(job);
  const kindPath = job.kind === "video_generate" ? "videos" : "images";
  const meta = skuMetadata(job);
  const succeeded = state === "succeeded";
  return {
    shot_index: shotIndexFromIdempotencyKey(job.idempotencyKey) ?? job.batchIndex ?? 0,
    shot_id: typeof meta.shotId === "string" ? meta.shotId : null,
    task_id: job.id,
    task_url: "/" + "v1/" + kindPath + "/" + job.id,
    status: job.status,
    task_state: state,
    model: job.modelId,
    kind: job.kind,
    billed: succeeded,
    billing_amount: job.billingAmount,
    failure_class: job.failureClass,
    failure_detail: job.failureDetail,
    result_url: succeeded ? "/v1/" + kindPath + "/" + job.id + "/result" : null,
    created_at: job.createdAt.toISOString(),
    finished_at: job.finishedAt ? job.finishedAt.toISOString() : null,
  };
}

export interface SkuRunStatusView {
  object: "sku.run.status";
  run_id: string;
  sku_id: string | null;
  status: "open" | "completed" | "cancelled";
  counts: Record<string, number>;
  billing: Record<string, number>;
  all_terminal: boolean;
  items: SkuRunItemView[];
}

/**
 * run 聚合視圖：聚合數學復用 batch 層的 computeBatchAggregate（同一套
 * task_status 分桶 + billingAmount 進出賬邏輯，不抄第二份）。
 */
export function buildSkuRunStatusView(runId: string, jobs: GenerationJob[]): SkuRunStatusView {
  const items = jobs.map(toSkuRunItemView);
  const synthesizedBatch: GenerationBatch = {
    id: runId,
    tenantId: jobs[0]?.tenantId ?? "",
    status: "open",
    totalCount: jobs.length,
    maxInFlight: null,
    idempotencyKey: null,
    requestHash: "",
    failedItems: [],
    createdAt: jobs[0]?.createdAt ?? new Date(0),
    completedAt: null,
    updatedAt: jobs[jobs.length - 1]?.updatedAt ?? new Date(0),
  };
  const aggregate = computeBatchAggregate(synthesizedBatch, jobs);
  const skuId = typeof skuMetadata(jobs[0]).skuId === "string"
    ? (skuMetadata(jobs[0]).skuId as string)
    : null;
  return {
    object: "sku.run.status",
    run_id: runId,
    sku_id: skuId,
    status: aggregate.status,
    counts: aggregate.counts as unknown as Record<string, number>,
    billing: aggregate.billing as unknown as Record<string, number>,
    all_terminal: aggregate.all_terminal,
    items,
  };
}
