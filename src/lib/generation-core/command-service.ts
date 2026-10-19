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
  /** 批量编排层（/v1/batches）回填：任务所属批与批内序号；单任务提交不带。 */
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
     * 模型可用性闸（circuit breaker）。缺省：控制面启用时用真实判定
     * （checkModelAvailability），否则不设闸；传 null 显式关闭。
     */
    availabilityGate?: ModelAvailabilityGate | null;
  } = {},
): Promise<SubmittedGenerationCommand> {
  const sql = options.sql ?? getGenerationSql();
  // 同一帧返工必须继承不可变制作关联，显式新配置仍由调用者负责。
  if (command.retryOfTaskId) {
    const original = await getGenerationJob(command.retryOfTaskId, sql);
    if (!original || original.tenantId !== command.tenantId) throw new Error('Retry source job does not belong to this tenant.');
    command = { ...command, workflow: { ...original.workflow, ...command.workflow,
      metadata: { ...original.workflow.metadata, ...command.workflow?.metadata } } };
  }
  if (command.kind === 'image_generate' && command.workflow?.references?.length) command = { ...command, kind: 'image_edit' };
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
    // R7-D（2026-08-29）：预设 deadline 只覆盖排队等容量的阶段（3 分钟）。
    // 供应商饱和的死单不再占用 15 分钟；真正开工后由 worker 依 started_at
    // 展期到 15 分钟总生成预算（extendGenerationDeadlineJob，GREATEST 防缩短）。
    deadlineAt: new Date(Date.now() + (command.deadlineMs ?? 3 * 60_000)),
  };
  // 模型可用性闸：在建单与预扣费（reserve）之前 fail-fast——被判死的模型不建 job、
  // 不动钱、不让用户白等到 deadline。唯一例外是同一幂等键的重放：原 job 已存在，
  // 照旧回同一 job（幂等承诺优先于闸门）。
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
