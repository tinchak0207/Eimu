import { randomUUID } from "node:crypto";
import { ingestRedeemedRecharges } from "./account-ledger";
import { runLifecycleEmailsWithSql } from "@/lib/lifecycle-email";
import { runReferralRewardsWithSql } from "@/lib/referral-reward";
import { productionWelcomeGiftDeps, runWelcomeGiftDevCatchUp } from "@/lib/welcome-gift";
import { ingestSubscriptionRedemptions } from "./subscription";
import { reconcileAccountBalances } from "./account-reconciliation";
import { commitGenerationBilling, reconcileGenerationBilling, refundGenerationBilling } from "./billing-ledger";
import { projectGatePathBilling } from "./billing-projection";
import { decryptGenerationPrompt } from "./crypto";
import { getGenerationSql, type GenerationSql } from "./database";
import { classifySupplierFailure, explainFailure, SupplierRequestError } from "./failure-classifier";
import { createFailureRecord } from "./failure-record";
import { planGenerationAttemptReplay } from "./operation-registry";
import { JOB_EVENT, emitJobEvent } from "./job-events";
import { persistOutputArtifact } from "./artifact-service";
import {
  attemptedSupplierRoutingForOutput,
  beginGenerationAttempt,
  claimNextGenerationJob,
  completeGenerationAttempt,
  completeGenerationJob,
  failGenerationAttempt,
  failGenerationJob,
  freezeGenerationJobForReconciliation,
  getGenerationJob,
  heartbeatGenerationJob,
  jobHasUnresolvedProviderTask,
  listCompletedGenerationArtifacts,
  listGenerationAttemptsForJob,
  markProviderTaskSubmitted,
  extendGenerationDeadlineJob,
  extendGenerationQueueDeadline,
  recoverExpiredGenerationLeases,
  releaseJobForRetry,
} from "./job-repository";
import { acquireSupplierLease, diagnoseSupplierUnavailability, heartbeatSupplierLease, recoverExpiredCooldowns, releaseSupplierLease, reportSupplierFailure, reportSupplierSuccess, type SupplierUnavailabilityReason } from "./scheduler";
import { generateWithSupplier, resolveSupplyAdapter } from "./supplier-adapter";
import { reconcileProtocolOf, workflowSeconds } from "./supply-registry";
import { enforcePaidVideoCostGate } from "./paid-video-cost-gate";
import type { GenerationArtifactResult, GenerationJob, GenerationKind, ProviderProtocol, SupplierGenerationInput, SupplierGenerationOutput, SupplierRecord } from "./types";
import { runProviderReconciliation } from "./provider-reconciliation";
import { refreshAdobeSupplierHealth } from "./adobe-health";
import { onFilmeraTokenRotated } from "./filmera-upstream";
import { refreshFilmeraSupplierHealth } from "./filmera-health";
import { readFile, writeFile } from "node:fs/promises";
import { emitJobRoutingEvent } from "../routing-telemetry";
import { sweepMapayIntakeOnce } from "@/lib/mapay-intake";

export interface GenerationWorkerOptions {
  workerId?: string;
  jobLeaseMs?: number;
  supplierLeaseMs?: number;
  pollMs?: number;
  /** 主循环同时在飞的任务数上限。供应商级并发由 supplier_lease 三层 concurrency_limit 把关，两层取小值生效。 */
  maxInFlight?: number;
  sql?: GenerationSql;
}

function backoffMs(attemptCount: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.min(6, attemptCount));
}

/**
 * INC-0831：supplier adapter_type → 对帐协议标记。V-06 起查 supply-registry：
 * 异步协议＝自身，同步协议＝其显式 `reconcileVia`，未知协议抛错（不再 default 成 newapi_video）。
 */
function protocolOfAdapter(adapterType: SupplierRecord["adapterType"]): ProviderProtocol {
  return reconcileProtocolOf(adapterType);
}

/**
 * 生产平面成本闸 + 供给提交（V-03，docs/architecture/planes.md §4）。
 *
 * 取得供给租约后、呼叫供给 adapter 前执行付费视频成本闸（原住在
 * openai-video-upstream.ts:158，只挡 openai_video）。只对 video_generate 生效：
 * - 闸看的 adapter＝真正会被呼叫的 adapter（resolveSupplyAdapter，含 kernel／new-api 分流）；
 * - `openai_video`（paidVideoFailClosed）一律过闸，白名单外拒收——与搬迁前一致；
 * - 其他协议只在上游 model 落入白名单时套价检，metaso/filmera 等既有路径放行不审。
 * 拒收＝SupplierRequestError(400)，在 fetch 之前抛出（零上游支出），走既有失败路径。
 */
export async function submitWithSupplyCostGate(
  supplier: SupplierRecord,
  input: SupplierGenerationInput,
): Promise<SupplierGenerationOutput> {
  if (input.kind === "video_generate") {
    const adapter = resolveSupplyAdapter(supplier, input);
    const facts = adapter.paidVideoFacts?.(supplier, input) ?? {
      supplierModelId: supplier.supplierModelId ?? input.modelId,
      resolution: input.resolution,
      seconds: workflowSeconds(input),
    };
    enforcePaidVideoCostGate(
      { ...facts, supplierId: supplier.id, supplierLabel: supplier.label, jobId: input.jobId },
      { failClosed: adapter.paidVideoFailClosed === true },
    );
  }
  return generateWithSupplier(supplier, input);
}

// 病灶 D（2026-08-30）：排队期退避不再撞穿 3 分钟 deadline。
// - WINDOW：deadline 只剩 <30s 才顺延（避免无意义地提前续）。
// - STEP：每次顺延 +5min（extendGenerationQueueDeadline 相对 now 增量）。
// - CAP：排队总预算相对 started_at 封顶 20min，超过就不再顺延，让
//   deadline_exceeded 正常杀单 —— 纯无供应商的死路不会无限挂单。
const QUEUE_EXTENSION_WINDOW_MS = 30_000;
const QUEUE_EXTENSION_STEP_MS = 5 * 60_000;
const QUEUE_EXTENSION_CAP_MS = 20 * 60_000;

/** 可恢复的等容量状态才允许排队顺延；纯死路（供应商被排除/全 disabled/未 seed 等）不延。 */
const RECOVERABLE_QUEUE_REASONS: ReadonlySet<SupplierUnavailabilityReason> = new Set([
  "suppliers_cooldown",
  "capacity_saturated",
  "accounts_unhealthy",
]);

/**
 * 开工后的生成预算（2026-09-27 INC-VIDEO-0927）。
 *
 * 影片上游实测比图片慢一个量级：napi 单次 attempt 最长 993.9s（16.6 分钟）、
 * 30 秒档成功单均 868s；adapter 内轮询窗口原本只有 540s（9 分钟），
 * 已实录 1 笔 "openai-video upstream generation timed out after 540s
 * (last status: in_progress)" —— 慢而健康的上游被我们的窗口误杀。
 * 影片类（video_generate / avatar / lipsync 同为异步影片族）放宽到 25 分钟
 * （含成品下载与持久化），其余维持 15 分钟。
 */
const GENERATION_BUDGET_MS = 15 * 60_000;
const VIDEO_GENERATION_BUDGET_MS = 25 * 60_000;

/** 按任务类型取开工后生成预算（纯函数，供测试直接断言）。 */
export function generationBudgetMs(kind: GenerationKind): number {
  return kind === "video_generate" || kind === "avatar" || kind === "lipsync"
    ? VIDEO_GENERATION_BUDGET_MS
    : GENERATION_BUDGET_MS;
}

/** 排队顺延决策：deadline 快到期 + 未超排队上限 + 处在可恢复状态。纯逻辑，供测试直接断言。 */
export function shouldExtendQueueDeadline(input: {
  diagnosisReason: SupplierUnavailabilityReason;
  deadlineAt: Date;
  startedAt: Date | null;
  now: number;
  windowMs?: number;
  capMs?: number;
}): boolean {
  const { diagnosisReason, deadlineAt, startedAt, now } = input;
  if (!startedAt) return false;
  const windowMs = input.windowMs ?? QUEUE_EXTENSION_WINDOW_MS;
  const capMs = input.capMs ?? QUEUE_EXTENSION_CAP_MS;
  if (deadlineAt.getTime() - now >= windowMs) return false;
  if (now >= startedAt.getTime() + capMs) return false;
  return RECOVERABLE_QUEUE_REASONS.has(diagnosisReason);
}

/**
 * 欠费无替补即时失败（2026-09-28 漫剧评测实锤）：唯一视频渠道回 401＋insufficient_user_quota
 * 时，registry 只认原生 402 为硬停，job 被放回伫列；帐号进 30 分钟 cooldown 后再无可租
 * 供应商，单子以 overloaded 空转到 25 分钟 deadline 才死——用户等 25 分钟只拿到「超时」。
 * 本 job 上一次失败已判定欠费，且诊断显示没有别的可用供应商（全被排除／冷却／不健康）
 * → 立即失败＋退款，让上游如实说「渠道余额不足」。容量满（capacity_saturated）不算：
 * 那代表还有别的健康供应商在忙，值得等。纯逻辑，供测试直接断言。
 */
const EXHAUSTED_SUPPLY_REASONS: ReadonlySet<SupplierUnavailabilityReason> = new Set([
  "supplier_excluded",
  "suppliers_cooldown",
  "accounts_unhealthy",
]);

export function shouldFailFastOnExhaustedSupply(input: {
  lastFailureClass: string | null;
  diagnosisReason: SupplierUnavailabilityReason;
}): boolean {
  return failFastClassForExhaustedSupply(input) !== null;
}

/**
 * 无替补时以「真因」终结的 failure_class（H-fix 2026-10-02）：quota_exhausted（欠费）与
 * pricing_config（上游定价/本地配置错，重试同供应商必同错）都不该空转到 deadline、
 * 更不该被标成 overloaded。回传 null 表示仍值得排队等。
 */
export function failFastClassForExhaustedSupply(input: {
  lastFailureClass: string | null;
  diagnosisReason: SupplierUnavailabilityReason;
}): "quota_exhausted" | "pricing_config" | null {
  if (!EXHAUSTED_SUPPLY_REASONS.has(input.diagnosisReason)) return null;
  if (input.lastFailureClass === "quota_exhausted" || input.lastFailureClass === "pricing_config") return input.lastFailureClass;
  return null;
}

/** 病灶 D：把 extend 实际写入 DB 的 deadline 同步回内存 job.deadlineAt，消除语义漂移。 */
export function applyExtendedDeadline(job: GenerationJob, extendedTo: Date | null): void {
  if (extendedTo) job.deadlineAt = extendedTo;
}

async function refundFailure(job: GenerationJob, completed: number, workerId: string, sql: GenerationSql): Promise<void> {
  const committed = job.requestedCount
    ? Math.floor(job.billingAmount * Math.min(job.requestedCount, completed) / job.requestedCount)
    : 0;
  await commitGenerationBilling(job, committed, sql);
  const refund = Math.max(0, job.billingAmount - committed);
  if (!refund) return;
  const result = await refundGenerationBilling({ job, amount: refund, executorId: workerId }, sql);
  if (result !== "applied") console.error(`[generation-worker] refund requires reconciliation job=${job.id} state=${result}`);
}

async function executeGenerationJob(job: GenerationJob, workerId: string, options: Required<Pick<GenerationWorkerOptions, "jobLeaseMs" | "supplierLeaseMs">>, sql: GenerationSql): Promise<void> {
  const artifacts: GenerationArtifactResult[] = await listCompletedGenerationArtifacts(job.id, sql);
  const prompt = decryptGenerationPrompt(job.promptCiphertext);
  let completed = job.completedCount;
  const heartbeat = setInterval(() => {
    // 心跳失败只是暂时写不进 DB，租约到期会自然回收，不值得杀整个进程。
    void heartbeatGenerationJob(job.id, workerId, options.jobLeaseMs, sql).catch((error) => {
      console.error(`[generation-worker] 心跳写入失败（非致命） job=${job.id}`, error);
    });
  }, Math.max(1_000, Math.floor(options.jobLeaseMs / 3)));

  try {
    while (completed < job.requestedCount) {
      if (Date.now() >= job.deadlineAt.getTime()) {
        // INC-0831 铁律：deadline 只代表「我们的等待预算」用完，不代表上游失败。
        // 有在飞上游任务 → 冻结进对帐（submit_unknown），钱不动，真相由
        // provider-reconciliation 查出来再结算；没有在飞任务 → 走原诚实失败+退款。
        if (await jobHasUnresolvedProviderTask(job.id, sql)) {
          await freezeGenerationJobForReconciliation({
            jobId: job.id,
            workerId,
            reason: "Generation deadline elapsed with a submitted provider task outstanding; frozen for reconciliation.",
          }, sql);
          return;
        }
        await failGenerationJob({ jobId: job.id, workerId, failureClass: "deadline_exceeded", failureDetail: "Generation deadline elapsed before all outputs completed." }, sql);
        await refundFailure(job, completed, workerId, sql);
        const jobAttempts = await listGenerationAttemptsForJob(job.id, sql);
        await emitJobRoutingEvent({ job, attempts: jobAttempts, outcome: "exhausted", refunded: true });
        return;
      }
      // 人工取消检查：job 已 cancelled（或租约易主）→ 停止后续 attempt，
      // 在飞产出丢弃、不调 completeGenerationJob；钱由 reconcileGenerationBilling
      // 对终态 job 按已完成张数 commit、退还差额兜底。
      const currentJob = await getGenerationJob(job.id, sql);
      if (!currentJob || currentJob.status === "cancelled" || currentJob.leaseOwner !== workerId) {
        return;
      }
      const attempted = await attemptedSupplierRoutingForOutput(job.id, completed, sql);
      const supplierLease = await acquireSupplierLease({
        job,
        workerId,
        outputIndex: completed,
        excludedSupplierIds: attempted.supplierIds,
        excludedFailureDomains: attempted.failureDomains,
        leaseMs: options.supplierLeaseMs,
      }, sql);
      if (supplierLease) {
        // R7-D：排队 3 分钟 deadline 只保护等容量阶段；真的租到供应商开工了，
        // 立即按 started_at 展期到生成总预算（慢而健康的影片单不被误杀）。
        // 病灶 D：extend 返回实际写入的 deadline，同步回内存 job.deadlineAt，
        // 否则内存仍停在 claim 时的 3 分钟快照，长任务会被误杀。
        // INC-VIDEO-0927：预算按 kind 分级（影片 25 分钟，其余 15 分钟）。
        const extendedTo = await extendGenerationDeadlineJob(job, workerId, generationBudgetMs(job.kind), sql).catch(() => null);
        applyExtendedDeadline(job, extendedTo);
      }
      if (!supplierLease) {
        // 诊断为什么没租到：同一句 "overloaded" 底下至少有六种完全不同的成因，
        // 处置也完全不同。诊断只在失败后跑一次，不在热路径上。
        // 诊断自身失败不能盖掉重试逻辑，所以兜一个保守的说法。
        // 排除链（2026-08-29）：把本 job 已失败过的 supplier / failure domain 与
        // 最近一次上游失败原文带进诊断，否则单供应商渠道第一次 attempt 失败后
        // 必然被自己排除，诊断会谎报「healthy but limits full」。仅失败路径多查一次。
        const jobAttempts = await listGenerationAttemptsForJob(job.id, sql).catch(() => []);
        const lastFailureDetail = [...jobAttempts]
          .reverse()
          .find((candidate) => candidate.status === "failed" && candidate.failureDetail)?.failureDetail ?? null;
        const diagnosis = await diagnoseSupplierUnavailability(job, sql, {
          supplierIds: attempted.supplierIds,
          failureDomains: attempted.failureDomains,
          lastFailureDetail,
        }).catch(() => ({
          reason: "capacity_saturated" as const,
          detail: "Supplier diagnosis itself failed; the job will retry with backoff.",
        }));
        const lastFailureClass = [...jobAttempts]
          .reverse()
          .find((candidate) => candidate.status === "failed")?.failureClass ?? null;
        const failFastClass = failFastClassForExhaustedSupply({ lastFailureClass, diagnosisReason: diagnosis.reason });
        if (failFastClass) {
          await failGenerationJob({
            jobId: job.id,
            workerId,
            failureClass: failFastClass,
            failureDetail: `No alternative supplier after ${failFastClass === "pricing_config" ? "upstream pricing/config error" : "upstream balance exhaustion"} (${diagnosis.reason}): ${lastFailureDetail ?? diagnosis.detail}`,
          }, sql);
          await refundFailure(job, completed, workerId, sql);
          const attemptsAfterFail = await listGenerationAttemptsForJob(job.id, sql).catch(() => jobAttempts);
          await emitJobRoutingEvent({ job, attempts: attemptsAfterFail, outcome: "exhausted", refunded: true });
          return;
        }
        // 病灶 D：排队期退避撞穿 deadline —— 无 lease 反覆 claim→释放直到 3 分钟
        // deadline 到期被 deadline_exceeded 杀单（实录 12 笔 video job，attempt_count=0）。
        // 当 deadline 快到期且处在「可恢复」的等容量状态（cooldown 未到 / 并发满 /
        // 账号暂挂）时顺延一次；纯死路（suppliers_disabled / supplier_excluded /
        // 未 seed 等）不延，超过 started_at 起的 20min 排队上限也不延。
        if (shouldExtendQueueDeadline({
          diagnosisReason: diagnosis.reason,
          deadlineAt: job.deadlineAt,
          startedAt: job.startedAt,
          now: Date.now(),
        })) {
          const extendedTo = await extendGenerationQueueDeadline(job, workerId, QUEUE_EXTENSION_STEP_MS, sql).catch(() => null);
          applyExtendedDeadline(job, extendedTo);
        }
        await releaseJobForRetry({
          jobId: job.id,
          workerId,
          availableAt: new Date(Date.now() + backoffMs(job.attemptCount)),
          failureClass: "overloaded",
          failureDetail: `${diagnosis.reason}: ${diagnosis.detail}`,
        }, sql);
        return;
      }
      const supplierHeartbeat = setInterval(() => {
        // 心跳失败只是暂时写不进 DB，租约到期会自然回收，不值得杀整个进程。
        void heartbeatSupplierLease(supplierLease.id, workerId, options.supplierLeaseMs, sql).catch((error) => {
          console.error(`[generation-worker] 供应商租约心跳失败（非致命） lease=${supplierLease.id}`, error);
        });
      }, Math.max(1_000, Math.floor(options.supplierLeaseMs / 3)));
      const startedAt = Date.now();
      let attemptId: string | null = null;
      // 刚失败那次 attempt 的序号（FG-02/03：重放裁决的唯一状态输入，非呼叫方预算）。
      let attemptNo: number | null = null;
      try {
        const attempt = await beginGenerationAttempt({
          jobId: job.id,
          workerId,
          supplierId: supplierLease.supplier.id,
          supplierModelId: supplierLease.supplier.supplierModelId,
          outputIndex: completed,
        }, sql);
        attemptId = attempt.id;
        attemptNo = attempt.attemptNo;
        // INC-0830-VIDEO / INC-0831：适配器在上游提交完成、取得 provider task id 的瞬间
        // 回调 → 先 durably 万 attempt 行（task id + 对帐排程；事故根治点：只发事件
        // 不落行 = 轮询断掉后 task id 无人认领），再落 attempt_submitted 事件（遥测）。
        const onProviderTaskSubmitted = (providerTaskId: string, protocol: ProviderProtocol): void => {
          void markProviderTaskSubmitted({
            jobId: job.id,
            attemptId: attempt.id,
            providerTaskId,
            protocol,
          }, sql).catch((error) => {
            console.error(`[generation-worker] provider task id 落库失败（对帐靠失败路径兜底） job=${job.id} task=${providerTaskId}`, error);
          });
          emitJobEvent({
            jobId: job.id,
            event: JOB_EVENT.attemptSubmitted,
            actor: `worker:${workerId}`,
            detail: {
              attempt_id: attempt.id,
              attempt_no: attempt.attemptNo,
              output_index: completed,
              supplier_id: supplierLease.supplier.id,
              provider_task_id: providerTaskId,
              protocol,
            },
          }, sql);
        };
        const output = await submitWithSupplyCostGate(supplierLease.supplier, {
          jobId: job.id,
          attemptId: attempt.id,
          modelId: job.modelId,
          supplierModelId: supplierLease.supplier.supplierModelId,
          prompt,
          kind: job.kind,
          size: job.size,
          ratio: job.ratio,
          resolution: job.resolution,
          quality: job.quality,
          workflow: job.workflow,
          onProviderTaskSubmitted,
        });
        const stored = await persistOutputArtifact({
          jobId: job.id,
          attemptId: attempt.id,
          outputIndex: completed,
          base64: output.base64,
          url: output.url,
          endpointLabel: output.endpointLabel,
          mediaKind: job.kind === "tts" ? "audio" : (job.kind === "video_generate" || job.kind === "avatar" || job.kind === "lipsync") ? "video" : "image",
        }, sql);
        const latencyMs = Date.now() - startedAt;
        await completeGenerationAttempt({
          jobId: job.id,
          workerId,
          attemptId: attempt.id,
          providerRequestId: output.providerRequestId,
          providerTaskId: output.providerTaskId,
          providerHttpStatus: output.httpStatus,
          latencyMs,
          evidence: output.evidence,
          // INC-0831：canonical artifact 早已存在（重放/晚到命中幂等键）→ 只记 attempt，不重复计数。
          advanceOutput: stored.inserted,
        }, sql);
        // INC-0830-VIDEO：attempt 成功事件（append-only）。
        emitJobEvent({
          jobId: job.id,
          event: JOB_EVENT.attemptSucceeded,
          actor: `worker:${workerId}`,
          detail: {
            attempt_id: attempt.id,
            attempt_no: attempt.attemptNo,
            supplier_id: supplierLease.supplier.id,
            provider_task_id: output.providerTaskId ?? null,
            latency_ms: latencyMs,
          },
        }, sql);
        await reportSupplierSuccess({
          supplierId: supplierLease.supplier.id,
          accountId: supplierLease.supplier.account.id,
          capabilityId: supplierLease.supplier.capabilityId,
        }, latencyMs, sql);
        artifacts.push({
          id: stored.id,
          outputIndex: completed,
          url: stored.deliveryUrl,
          mimeType: stored.validated.mimeType,
          sha256: stored.validated.sha256,
          width: stored.validated.width,
          height: stored.validated.height,
          endpointLabel: output.endpointLabel,
        });
        completed += 1;
      } catch (error) {
        const failure = classifySupplierFailure(error);
        // FG-01：先把上游原生错误逐字捕获成版本化记录（与产品解释分栏存放），
        // 之后所有落库路径共用同一份 record —— 解释永不覆写原生栏位。
        const failureRecord = createFailureRecord({ error, explanation: explainFailure(failure) });
        // INC-0830-VIDEO：适配器抛错时带出的上游任务 id，回填 attempt 行。
        const failedProviderTaskId = error instanceof SupplierRequestError ? error.providerTaskId : undefined;
        if (attemptId) {
          await failGenerationAttempt({
            jobId: job.id,
            workerId,
            attemptId,
            failureClass: failure.failureClass,
            failureDetail: failure.detail,
            failureRecord,
            providerTaskId: failedProviderTaskId,
            providerHttpStatus: failure.httpStatus,
            retryAfterAt: failure.cooldownUntil,
            latencyMs: Date.now() - startedAt,
          }, sql);
          // INC-0831：失败路径的 task id 保险回填（提交回调写入失败时的兜底；
          // 同 id 幂等，不同 id 不覆盖）。之后该 attempt 立即进对帐队列。
          if (failedProviderTaskId) {
            await markProviderTaskSubmitted({
              jobId: job.id,
              attemptId,
              providerTaskId: failedProviderTaskId,
              protocol: protocolOfAdapter(supplierLease.supplier.adapterType),
              firstPollDelayMs: 60_000,
            }, sql).catch((reconcileError) => {
              console.error(`[generation-worker] 失败路径 task id 回填失败 job=${job.id} task=${failedProviderTaskId}`, reconcileError);
            });
          }
          // attempt 失败事件：upstream_raw = 错误原文（不改写），供 probe 直查死因。
          emitJobEvent({
            jobId: job.id,
            event: JOB_EVENT.attemptFailed,
            actor: `worker:${workerId}`,
            upstreamRaw: failure.detail,
            detail: {
              attempt_id: attemptId,
              supplier_id: supplierLease.supplier.id,
              failure_class: failure.failureClass,
              provider_task_id: failedProviderTaskId ?? null,
              provider_http_status: failure.httpStatus ?? null,
            },
          }, sql);
        }
        await reportSupplierFailure({
          supplierId: supplierLease.supplier.id,
          accountId: supplierLease.supplier.account.id,
          capabilityId: supplierLease.supplier.capabilityId,
        }, failure, sql);
        // FG-02/03（2026-09-23）：自动重放许可**只**由封闭 operation registry 裁决
        // （operation-registry.ts）。产品分类（retryable/switchSupplier）不再参与——
        // 分类是关键字词表猜的，喂给钱的决策就是「解释决定再花一次钱」。
        // 原生硬停（402/400/422/451：确定性失败，同一个请求换渠道也不可能成功）由 registry
        // 政策宣告，输入是 FailureRecord.native 的原始 HTTP 状态，不是产品 category。
        // 402 例外来自暴君 2026-08-29 裁定（fail-fast，立刻诚实失败＋退款）；改判须暴君点名。
        const replay = planGenerationAttemptReplay({
          kind: job.kind,
          lastAttemptNo: attemptNo,
          nativeFailure: failureRecord.native,
        });
        if (!replay.allowed) {
          emitJobEvent({
            jobId: job.id,
            event: JOB_EVENT.replayDenied,
            actor: `worker:${workerId}`,
            upstreamRaw: failure.detail,
            detail: {
              operation: replay.operation,
              denial_reason: replay.denialReason,
              next_attempt_no: replay.nextAttemptNo,
              max_replay_attempts: replay.maxReplayAttempts,
              hard_stop_status: replay.hardStop?.status ?? null,
            },
          }, sql);
          // INC-0831 铁律：上游已提交的任务不因任何裁决被判死。先冻结进对帐
          //（钱不动），reconciliation 查出上游确认失败才退款。
          if (failedProviderTaskId) {
            await freezeGenerationJobForReconciliation({
              jobId: job.id,
              workerId,
              reason: `Replay denied (${replay.denialReason ?? "unknown"}) with a submitted provider task outstanding; frozen for reconciliation: ${failure.detail}`,
            }, sql);
            return;
          }
          await failGenerationJob({
            jobId: job.id,
            workerId,
            failureClass: failure.failureClass,
            failureDetail: failure.detail,
            failureRecord,
          }, sql);
          await refundFailure(job, completed, workerId, sql);
          const jobAttempts = await listGenerationAttemptsForJob(job.id, sql);
          await emitJobRoutingEvent({ job, attempts: jobAttempts, outcome: "exhausted", refunded: true });
          return;
        }
      } finally {
        clearInterval(supplierHeartbeat);
        await releaseSupplierLease(supplierLease.id, workerId, sql);
      }
    }
    await completeGenerationJob({ jobId: job.id, workerId, artifacts }, sql);
    await commitGenerationBilling(job, job.billingAmount, sql);
    const jobAttempts = await listGenerationAttemptsForJob(job.id, sql);
    await emitJobRoutingEvent({ job, attempts: jobAttempts, outcome: "delivered", refunded: false });
  } finally {
    clearInterval(heartbeat);
  }
}

/** Claim one queued job without executing it. Exported for the concurrent pool loop. */
export async function claimGenerationJob(options: GenerationWorkerOptions = {}): Promise<GenerationJob | null> {
  const sql = options.sql ?? getGenerationSql();
  const workerId = options.workerId ?? `worker:${process.env.HOSTNAME ?? "local"}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const jobLeaseMs = options.jobLeaseMs ?? Number(process.env.GENERATION_JOB_LEASE_MS ?? 120_000);
  return claimNextGenerationJob(workerId, jobLeaseMs, sql);
}

/** Execute a job claimed by claimGenerationJob. Exported for the concurrent pool loop. */
export async function executeClaimedGenerationJob(job: GenerationJob, options: GenerationWorkerOptions = {}): Promise<void> {
  const sql = options.sql ?? getGenerationSql();
  const workerId = job.leaseOwner ?? `worker:${process.env.HOSTNAME ?? "local"}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const jobLeaseMs = options.jobLeaseMs ?? Number(process.env.GENERATION_JOB_LEASE_MS ?? 120_000);
  const supplierLeaseMs = options.supplierLeaseMs ?? Number(process.env.GENERATION_SUPPLIER_LEASE_MS ?? 120_000);
  await executeGenerationJob(job, workerId, { jobLeaseMs, supplierLeaseMs }, sql);
}

/** Claim and process at most one job. Exported for deterministic integration tests. */
export async function runGenerationWorkerOnce(options: GenerationWorkerOptions = {}): Promise<boolean> {
  const job = await claimGenerationJob(options);
  if (!job) return false;
  await executeClaimedGenerationJob(job, options);
  return true;
}

/**
 * 维护闭环单次执行（Vercel cron 入口用）：runGenerationWorkerOnce 只派单不含维护，
 * cron 进程必须另跑这组（租约回收/计费结算/provider 对帐/健康巡检），
 * 否则长驻 worker 关停期间对帐就断粮（INC-0831 教训：真相查询不能只有一条心跳）。
 */
export async function runGenerationMaintenanceOnce(options: GenerationWorkerOptions = {}): Promise<void> {
  const sql = options.sql ?? getGenerationSql();
  const executorId = options.workerId
    ? `billing:${options.workerId}`
    : `billing:${process.env.HOSTNAME ?? "local"}:${process.pid}`;
  await recoverExpiredGenerationLeases(sql);
  await reconcileGenerationBilling({ executorId, sql });
  await projectGatePathBilling({ executorId, sql });
  // INC-0831：provider 对帐循环——按 task id 查上游真相，晚到成品落地、
  // 确认失败才退款、窗口耗尽冻结人工。
  await runProviderReconciliation({ executorId, sql });
  await runAccountMaintenanceOnce(sql);
  await refreshAdobeSupplierHealth(sql);
  await refreshFilmeraSupplierHealth(sql);
  await recoverExpiredCooldowns(sql);
}

/**
 * REQ-E1a/E1b 帐本维护（充值入帐同步 + 跨层对帐）。
 *
 * 节奏刻意与 30s 记帐循环解耦：对帐每个身份一次上游 GET，30s 跑一轮会打爆 new-api。
 * 默认 10 分钟一次（ACCOUNT_MAINTENANCE_INTERVAL_MS 可调）；两件事都只读+幂等写入，
 * 任何失败只 console.error（沿用既有告警通道），绝不挡任务路径。
 */
const ACCOUNT_MAINTENANCE_INTERVAL_MS_DEFAULT = 10 * 60_000;
let lastAccountMaintenanceAt = 0;

export async function runAccountMaintenanceOnce(
  sql: GenerationSql,
  now = Date.now(),
): Promise<boolean> {
  const raw = Number(process.env.ACCOUNT_MAINTENANCE_INTERVAL_MS ?? "");
  const intervalMs = Number.isFinite(raw) && raw > 0 ? raw : ACCOUNT_MAINTENANCE_INTERVAL_MS_DEFAULT;
  if (now - lastAccountMaintenanceAt < intervalMs) return false;
  lastAccountMaintenanceAt = now;

  try {
    const recharges = await ingestRedeemedRecharges({}, { sql });
    console.log(
      `[account-ledger] 充值入帐扫描 scanned=${recharges.scanned} charged=${recharges.charged} ` +
        `基线前已补记=${recharges.chargedBaselineAbsorbed} 未使用=${recharges.skippedUnused} ` +
        `基线前漏记=${recharges.skippedBeforeBaseline} ` +
        `订阅码=${recharges.skippedSubscription} errors=${recharges.errors.length}`,
    );
  } catch (error) {
    console.error("[account-ledger] 充值入帐失败（继续）", error);
  }
  // REQ-D3：订阅兑换码 → 期次发放（读同一份上游兑换记录；带 SKU 标记的码只走这条，
  // 永久充值通道已明确跳过它们）。注意本扫描**不**做「到期清零」——过期是读取时 lazy
  // 判定的，这里只处理「有人兑换了订阅码」这一个事件。
  try {
    const subscriptions = await ingestSubscriptionRedemptions({}, { sql });
    console.log(
      `[subscription] 订阅发放扫描 scanned=${subscriptions.scanned} granted=${subscriptions.granted} ` +
        `已发放=${subscriptions.skippedAlreadyGranted} 未使用=${subscriptions.skippedUnused} ` +
        `基线前=${subscriptions.skippedBeforeBaseline} 未注册SKU=${subscriptions.unknownSku} ` +
        `errors=${subscriptions.errors.length}`,
    );
  } catch (error) {
    console.error("[subscription] 订阅发放失败（继续）", error);
  }
  try {
    const referral = await runReferralRewardsWithSql(sql);
    if (referral.granted || referral.failed || referral.skipped) {
      console.log(`[referral] granted=${referral.granted} skipped=${referral.skipped} failed=${referral.failed}${referral.aborted ? " aborted" : ""}`);
    }
  } catch (error) {
    console.error("[referral] 邀请奖励失败（继续）", error);
  }
  // 新人礼兜底：开发者建了 biz key 但用 API、不会再登录网站，/api/auth/me 的补发打不到他们。
  // 这里对「持有 biz key ∧ 未领过新人礼 ∧ 没成功出图」的外部用户自动补发（复用 grantWelcomeGift），
  // 每轮上限 20 人，幂等占位表保证与登录/回溯路径并发也只发一次。
  try {
    const dev = await runWelcomeGiftDevCatchUp(productionWelcomeGiftDeps(sql));
    if (dev.scanned > 0) {
      console.log(`[welcome-gift] 开发者补发 scanned=${dev.scanned} granted=${dev.granted} skipped=${dev.skipped} failed=${dev.failed}`);
    }
  } catch (error) {
    console.error("[welcome-gift] 开发者补发失败（继续）", error);
  }
  try {
    const mail = await runLifecycleEmailsWithSql(sql);
    console.log(`[lifecycle-email] sent=${mail.sent} failed=${mail.failed}${mail.skipped ? ` skipped=${mail.skipped}` : ""}${mail.aborted ? ` aborted=${mail.aborted}` : ""}`);
  } catch (error) {
    console.error("[lifecycle-email] 生命周期邮件失败（继续）", error);
  }
  try {
    const report = await reconcileAccountBalances({}, { sql });
    console.log(
      `[account-reconcile] users=${report.totals.users} matched=${report.totals.matched} ` +
        `explained=${report.totals.explained} unseeded=${report.totals.unseeded} ` +
        `unknown=${report.totals.unknown} alerts=${report.alerts.length}`,
    );
  } catch (error) {
    console.error("[account-reconcile] 跨层对帐失败（继续）", error);
  }
  return true;
}

export async function runGenerationWorker(options: GenerationWorkerOptions = {}): Promise<void> {
  const sql = options.sql ?? getGenerationSql();
  const pollMs = options.pollMs ?? Number(process.env.GENERATION_WORKER_POLL_MS ?? 1_000);
  // 并发池：旧主循环「租一单同步等到上游跑完再租下一单」，突发任务在第 N 单上
  // 叠加前 N-1 单的上游时长（实录：metaso 9 连发中控时延 70s→355s 线性增长）。
  // 上游并发上限由 supplier/account/capability 三层 concurrency_limit 在
  // acquireSupplierLease 内把关（SKIP LOCKED，超限走 overloaded 退避重投），
  // 这里只约束全进程同时在飞的单数，两层取小值生效。
  const maxInFlight = Math.max(1, options.maxInFlight ?? Number(process.env.GENERATION_WORKER_CONCURRENCY ?? 6));
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let lastMaintenance = 0;
  const billingExecutorId = `billing:${process.env.HOSTNAME ?? "local"}:${process.pid}`;
  // filmera token 轮换持久化：内存换新后原子写回 env 文件，
  // worker 重启不丢失 refresh_token 链（否则每次重启都退回旧 token → 401 死锁）。
  const envPath = process.env.FILMERA_ENV_PATH ?? "/opt/image-control-plane/.env.control-plane";
  onFilmeraTokenRotated(async (next) => {
    try {
      const text = await readFile(envPath, "utf8");
      const lines = text.split("\n").filter((l) => !l.startsWith("FILMERA_AUTH_TOKEN=") && !l.startsWith("FILMERA_REFRESH_TOKEN="));
      lines.push(`FILMERA_AUTH_TOKEN=${next.accessToken}`);
      lines.push(`FILMERA_REFRESH_TOKEN=${next.refreshToken}`);
      // bind-mount 单文件挂载不支援 rename 覆盖（EBUSY），直接原地写入。
      // 写入期间理论上有瞬间不完整窗口，但 env 只在容器启动时读取，可接受。
      await writeFile(envPath, lines.join("\n"), "utf8");
      process.env.FILMERA_AUTH_TOKEN = next.accessToken;
      process.env.FILMERA_REFRESH_TOKEN = next.refreshToken;
    } catch (error) {
      console.warn("[generation-worker] filmera token 持久化失败（仅内存生效）", error instanceof Error ? error.message : String(error));
    }
  });
  const inFlight = new Set<Promise<void>>();
  const dispatch = (job: GenerationJob): void => {
    // finally 的清理改挂 task.finally()：promise 先落 const 才能自引用，
    // settle 后再从 inFlight 摘除，语义与原 finally 块等价（catch 已吞异常）。
    const task = (async () => {
      try {
        await executeClaimedGenerationJob(job, { ...options, sql });
      } catch (error) {
        // executeGenerationJob 内部已把可预期失败落成 attempt/fail 链；
        // 这里只兜真正意外的异常，不能让一单炸掉整个池。
        console.error("[generation-worker] 任务执行意外失败（继续轮询）", error);
      }
    })();
    inFlight.add(task);
    void task.then(() => inFlight.delete(task));
  };
  while (!stopping) {
    try {
      const now = Date.now();
      if (now - lastMaintenance > 30_000) {
        await recoverExpiredGenerationLeases(sql);
        await reconcileGenerationBilling({ executorId: billingExecutorId, sql });
        await projectGatePathBilling({ executorId: billingExecutorId, sql });
        // INC-0831：provider 对帐循环——按 task id 查上游真相，晚到成品落地、
        // 确认失败才退款、窗口耗尽冻结人工。与租约回收同节奏（30s）。
        await runProviderReconciliation({ executorId: billingExecutorId, sql }).catch((error) => {
          console.error("[generation-worker] provider reconciliation failed（继续）", error);
        });
        // REQ-E1a/E1b：充值入帐同步 + 跨层对帐（内部自带节奏门槛，非每轮执行）。
        await runAccountMaintenanceOnce(sql);
        await refreshAdobeSupplierHealth(sql);
        await refreshFilmeraSupplierHealth(sql);
        // 病灶 C：cooldown 到期自动恢复（disabled 不自动恢复）。每 30s 与健康循环
        // 一起扫一次，把「cooldown 已到期」的 supplier/account 捡回 healthy。
        await recoverExpiredCooldowns(sql);
        // mPay 落地存证自愈（2026-10-04）：把「已收到但没履约」的单用既有幂等路径重投。
        // 原本只挂在 /api/cron/generation-worker 上，而那条端点在两个平面都没有人呼叫
        // （Vercel 侧无 GENERATION_DATABASE_URL ⇒ 闸门前就 early return；VPS 无 cron/timer），
        // 等于没接线。改挂本长驻回圈；函式自带 10 分钟陈旧门槛与 limit，30s 一轮只是便宜扫描。
        // 失败不得影响本区块其余维护工作 ⇒ 自带 catch。
        await sweepMapayIntakeOnce(sql).catch((error) => {
          console.error("[generation-worker] mapay intake sweep failed（继续）", error);
        });
        lastMaintenance = now;
      }
      if (inFlight.size < maxInFlight) {
        const job = await claimGenerationJob({ ...options, sql });
        if (job) {
          dispatch(job);
          // 池未满且仍有积压：立刻继续租，让同一批突发一次拉满，不空转等下一个 poll。
          continue;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    } catch (error) {
      // 迭代失败（暂时性，继续轮询）
      console.error("[generation-worker] 迭代失败（暂时性，继续轮询）", error);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  // 停机：不再派新单，等在飞任务收尾（执行链自带租约心跳与退款兜底）。
  await Promise.allSettled(inFlight);
}
