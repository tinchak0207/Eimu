// SKU run 编排服务：run_id 管理、可插拔发射器、run 聚合查询与视图构建。
//
// 铁律：不自建第二套提交/计费/鉴权——每个镜头都走同一条 submitGenerationCommand
// （幂等键逐镜头生成），鉴权/限流在路由层复用既有 biz-api 模式。
//
// run 的状态存储论证（为什么「无状态优先」成立）：
// run_id 不落新表——它就是幂等键根。每个镜头任务带确定性幂等键
// skurun:<run_id>:<shot_index>，落在既有 generation_job.idempotency_key 上；
// GET /v1/skus/runs/:id 用前缀查询把 run 的任务捞回来聚合。零新迁移、零新表，
// 任务本身就是 run 的唯一事实源（提交/计费/状态全在 job 上）。量级大了再加
// 专用索引或 runs 表（见 docs TODO）。

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

/** run 幂等键前缀；与 /v1/batches 的 "batch:" 前缀命名空间互不重叠。 */
export const SKU_RUN_KEY_PREFIX = "skurun";
/** 单次请求最多展开几个 run（表格批量场景的上限）。 */
export const MAX_RUNS_PER_REQUEST = 10;
/** 单个 run 的镜头数上限（现有 SKU 最高 8；留余量给未来 SKU）。 */
export const MAX_SHOTS_PER_RUN = 12;
/** run_id 字符集：字母数字开头，允许连字号/下划线（幂等键与 LIKE 查询都安全）。 */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

/** 客户自带 run_id（或 Idempotency-Key）的合法性检查。 */
export function normalizeRunId(raw: unknown): { ok: true; runId: string } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: false, message: "run_id / Idempotency-Key 需为字符串。" };
  const trimmed = raw.trim();
  if (!RUN_ID_PATTERN.test(trimmed)) {
    return { ok: false, message: "run_id 需为 8-128 位字母数字开头的字符串（可含连字号/下划线）。" };
  }
  return { ok: true, runId: trimmed };
}

/** 生成新 run_id（客户未带 Idempotency-Key 时）。 */
export function generateRunId(): string {
  return "skurun_" + randomUUID();
}

/** 单镜头的确定性幂等键：崩溃后重放同一 run 时，已提交镜头不会重复建任务/扣费。 */
export function skuRunIdempotencyKey(runId: string, shotIndex: number): string {
  return SKU_RUN_KEY_PREFIX + ":" + runId + ":" + shotIndex;
}

/** 从幂等键反解镜头序号；非本层键回 null。 */
export function shotIndexFromIdempotencyKey(key: string | null): number | null {
  if (!key) return null;
  const match = new RegExp("^" + SKU_RUN_KEY_PREFIX + ":(.+):(\\d+)$").exec(key);
  if (!match) return null;
  const index = Number(match[2]);
  return Number.isInteger(index) ? index : null;
}

// ─────────────────────────────────────────── 镜头 → 提交计划

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
  /** 可选：附加进 workflow 元数据的输入线索（如 product_image_url，v1 仅记录）。 */
  extraMetadata?: Record<string, unknown>;
}

/** 把展开后的镜头计划转成 submitGenerationCommand 的输入形状（纯函数，可单测）。 */
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

// ─────────────────────────────────────────── 可插拔发射器

export interface SkuDispatchContext {
  tenantId: string;
  apiKeyId: string;
  billingUserId: number;
}

export interface SkuDispatchOutcome {
  shotIndex: number;
  accepted: boolean;
  taskId: string | null;
  /** true = 幂等重放命中既有任务（未重复建任务/扣费）。 */
  replayed?: boolean;
  error?: { message: string; type: "invalid_request_error" | "api_error"; code: string; param: null };
}

/**
 * 发射器接口：把一个 run 的全部镜头计划提交出去。
 * 默认实现 = 单任务循环（submitGenerationCommand 逐项、幂等键逐项）；
 * /v1/batches 批量端点就绪后，加一个 batch 实现并在 resolveSkuDispatcher
 * 一行切换——SKU 层其他代码不动。
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
          // 模型可用性闸：该镜头建单/扣费前拒绝，诚实回报（不假装提交）。
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
 * 发射器解析（切换点）：SKU_RUN_DISPATCHER=loop（默认）。
 * batch 值保留给「经 /v1/batches 批量端点发射」的实现——接入时在这里返回
 * batch dispatcher 即可，路由层与展开层零改动。
 */
export function resolveSkuDispatcher(env: NodeJS.ProcessEnv = process.env): SkuDispatcher {
  const mode = env.SKU_RUN_DISPATCHER?.trim().toLowerCase() ?? "loop";
  if (mode !== "loop") {
    console.warn("[sku-run] SKU_RUN_DISPATCHER=" + mode + " 尚未接入，回退 loop 发射器。");
  }
  return createLoopSkuDispatcher();
}

// ─────────────────────────────────────────── run 聚合查询（无状态）

type JobRow = Record<string, unknown>;

/**
 * 捞回一个 run 的全部镜头任务：按幂等键前缀（skurun:<run_id>:*）查既有
 * generation_job 表。run 不落新表——任务本身就是事实源。
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
  // 幂等键字典序在 shot_index >= 10 时错序（…:10 排在 …:2 前），按解析出的序号重排。
  return jobs.sort((left, right) => {
    const a = shotIndexFromIdempotencyKey(left.idempotencyKey) ?? 0;
    const b = shotIndexFromIdempotencyKey(right.idempotencyKey) ?? 0;
    return a - b;
  });
}

// ─────────────────────────────────────────── 视图构建（纯函数，可单测）

/** 从 job 的 workflow 元数据里取 SKU 回填信息。 */
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
 * run 聚合视图：聚合数学复用 batch 层的 computeBatchAggregate（同一套
 * task_status 分桶 + billingAmount 进出账逻辑，不抄第二份）。
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
