import { randomUUID } from "node:crypto";
import { reserveGenerationBilling } from "./billing-ledger";
import type { GenerationBillingAdapter } from "./billing-relay";
import { encryptGenerationPrompt, generationRequestHash } from "./crypto";
import { generationControlPlaneEnabled, getGenerationSql, type GenerationSql } from "./database";
import {
  checkModelAvailability,
  GenerationModelUnavailableError,
  type ModelAvailabilityGate,
} from "./model-availability-gate";
import {
  createGenerationJob,
  failGenerationJob,
  getGenerationJob,
  hasGenerationCapability,
  type CreatedJob,
} from "./job-repository";
import type { CreateGenerationJobInput, GenerationWorkflow } from "./types";

export interface GenerationCommand {
  jobId?: string;
  tenantId: string;
  apiKeyId?: string | null;
  billingUserId?: number | null;
  source: "web" | "biz" | "canary";
  idempotencyKey?: string | null;
  kind: "image_generate" | "image_edit" | "video_generate" | "tts" | "avatar" | "lipsync";
  routingClass?: "generic" | "firefly_only" | "hub_only";
  modelId: string;
  prompt: string;
  size?: string | null;
  ratio?: string | null;
  resolution?: string | null;
  quality?: string | null;
  workflow?: GenerationWorkflow;
  responseFormat?: "b64_json" | "url";
  callbackUrl?: string | null;
  retryOfTaskId?: string | null;
  /** 批量編排層（/v1/batches）回填：任務所屬批與批內序號；單任務提交不帶。 */
  batchId?: string | null;
  batchIndex?: number | null;
  referenceArtifacts?: CreateGenerationJobInput["referenceArtifacts"];
  requestedCount?: number;
  billingAmount?: number;
  deadlineMs?: number;
}

export interface SubmittedGenerationCommand extends CreatedJob {
  requestHash: string;
}

export async function submitGenerationCommand(
  command: GenerationCommand,
  options: {
    sql?: GenerationSql;
    billingAdapter?: GenerationBillingAdapter;
    executorId?: string;
    /**
     * 模型可用性閘（circuit breaker）。缺省：控制面啟用時用真實判定
     * （checkModelAvailability），否則不設閘；傳 null 顯式關閉。
     */
    availabilityGate?: ModelAvailabilityGate | null;
  } = {},
): Promise<SubmittedGenerationCommand> {
  const sql = options.sql ?? getGenerationSql();
  const requestedCount = command.requestedCount ?? 1;
  const routingClass = command.routingClass ?? "generic";
  const requestHash = generationRequestHash({
    kind: command.kind,
    routingClass,
    modelId: command.modelId,
    prompt: command.prompt,
    size: command.size ?? null,
    ratio: command.ratio ?? null,
    resolution: command.resolution ?? null,
    quality: command.quality ?? null,
    workflow: command.workflow ?? {},
    responseFormat: command.responseFormat ?? "b64_json",
    callbackUrl: command.callbackUrl ?? null,
    requestedCount,
  });
  const input: CreateGenerationJobInput = {
    id: command.jobId ?? randomUUID(),
    tenantId: command.tenantId,
    apiKeyId: command.apiKeyId ?? null,
    billingUserId: command.billingUserId ?? null,
    source: command.source,
    idempotencyKey: command.idempotencyKey?.trim() || null,
    requestHash,
    kind: command.kind,
    routingClass,
    modelId: command.modelId,
    size: command.size ?? null,
    ratio: command.ratio ?? null,
    resolution: command.resolution ?? null,
    quality: command.quality ?? null,
    promptCiphertext: encryptGenerationPrompt(command.prompt),
    workflow: command.workflow ?? {},
    responseFormat: command.responseFormat ?? "b64_json",
    callbackUrl: command.callbackUrl ?? null,
    retryOfTaskId: command.retryOfTaskId ?? null,
    batchId: command.batchId ?? null,
    batchIndex: command.batchIndex ?? null,
    referenceArtifacts: command.referenceArtifacts ?? [],
    requestedCount,
    billingAmount: command.billingAmount ?? 0,
    // R7-D（2026-08-29）：預設 deadline 只覆蓋排隊等容量的階段（3 分鐘）。
    // 供應商飽和的死單不再佔用 15 分鐘；真正開工後由 worker 依 started_at
    // 展期到 15 分鐘總生成預算（extendGenerationDeadlineJob，GREATEST 防縮短）。
    deadlineAt: new Date(Date.now() + (command.deadlineMs ?? 3 * 60_000)),
  };
  // 模型可用性閘：在建單與預扣費（reserve）之前 fail-fast——被判死的模型不建 job、
  // 不動錢、不讓用戶白等到 deadline。唯一例外是同一冪等鍵的重放：原 job 已存在，
  // 照舊回同一 job（冪等承諾優先於閘門）。
  const gate = options.availabilityGate === undefined
    ? (generationControlPlaneEnabled() ? defaultAvailabilityGate(sql) : null)
    : options.availabilityGate;
  if (gate) {
    const decision = await gate({ modelId: command.modelId, kind: command.kind });
    if (!decision.allowed && !(input.idempotencyKey && await idempotentJobExists(input.tenantId, input.idempotencyKey, sql))) {
      throw new GenerationModelUnavailableError(decision);
    }
  }

  const created = await createGenerationJob(input, sql);
  if (!created.created) {
    // The original HTTP process can die after committing the job but before it
    // claims the reserve operation. Replaying the same idempotent command may
    // safely claim only a still-pending operation; an executing/unknown one is
    // left untouched to avoid a duplicate external debit.
    const job = created.job.status === "pending_billing"
      ? await reserveGenerationBilling({
        job: created.job,
        executorId: options.executorId ?? `api:${process.pid}`,
        adapter: options.billingAdapter,
      }, sql)
      : created.job;
    return { job, created: false, requestHash };
  }

  const capable = await hasGenerationCapability({
    modelId: command.modelId,
    kind: command.kind,
    ratio: command.ratio,
    resolution: command.resolution,
    routingClass,
  }, sql);
  if (!capable) {
    await failGenerationJob({
      jobId: created.job.id,
      failureClass: "model_unsupported",
      failureDetail: "No enabled supplier capability matches this model, operation, ratio, and resolution.",
    }, sql);
    return { job: (await getGenerationJob(created.job.id, sql))!, created: true, requestHash };
  }

  const job = await reserveGenerationBilling({
    job: created.job,
    executorId: options.executorId ?? `api:${process.pid}`,
    adapter: options.billingAdapter,
  }, sql);
  return { job, created: true, requestHash };
}

function defaultAvailabilityGate(sql: GenerationSql): ModelAvailabilityGate {
  return ({ modelId }) => checkModelAvailability(modelId, { sql });
}

async function idempotentJobExists(tenantId: string, idempotencyKey: string, sql: GenerationSql): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM generation_job
    WHERE tenant_id = ${tenantId} AND idempotency_key = ${idempotencyKey}
    LIMIT 1
  `;
  return rows.length > 0;
}
