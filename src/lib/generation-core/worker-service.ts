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
import { generateWithSupplier } from "./supplier-adapter";
import type { GenerationArtifactResult, GenerationJob, GenerationKind, ProviderProtocol, SupplierRecord } from "./types";
import { runProviderReconciliation } from "./provider-reconciliation";
import { refreshAdobeSupplierHealth } from "./adobe-health";
import { onFilmeraTokenRotated } from "./filmera-upstream";
import { refreshFilmeraSupplierHealth } from "./filmera-health";
import { readFile, writeFile } from "node:fs/promises";
import { emitJobRoutingEvent } from "../routing-telemetry";

export interface GenerationWorkerOptions {
  workerId?: string;
  jobLeaseMs?: number;
  supplierLeaseMs?: number;
  pollMs?: number;
  /** 主循環同時在飛的任務數上限。供應商級併發由 supplier_lease 三層 concurrency_limit 把關，兩層取小值生效。 */
  maxInFlight?: number;
  sql?: GenerationSql;
}

function backoffMs(attemptCount: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.min(6, attemptCount));
}

/** INC-0831：supplier adapter_type → 對帳協議標記（同步 adapter 無異步任務語義，不在此列）。 */
function protocolOfAdapter(adapterType: SupplierRecord["adapterType"]): ProviderProtocol {
  switch (adapterType) {
    case "metaso":
      return "metaso";
    case "openai_video":
      return "openai_video";
    case "filmera":
      return "filmera";
    default:
      return "newapi_video";
  }
}

// 病灶 D（2026-08-30）：排隊期退避不再撞穿 3 分鐘 deadline。
// - WINDOW：deadline 只剩 <30s 才順延（避免無意義地提前續）。
// - STEP：每次順延 +5min（extendGenerationQueueDeadline 相對 now 增量）。
// - CAP：排隊總預算相對 started_at 封頂 20min，超過就不再順延，讓
//   deadline_exceeded 正常殺單 —— 純無供應商的死路不會無限掛單。
const QUEUE_EXTENSION_WINDOW_MS = 30_000;
const QUEUE_EXTENSION_STEP_MS = 5 * 60_000;
const QUEUE_EXTENSION_CAP_MS = 20 * 60_000;

/** 可恢復的等容量狀態才允許排隊順延；純死路（供應商被排除/全 disabled/未 seed 等）不延。 */
const RECOVERABLE_QUEUE_REASONS: ReadonlySet<SupplierUnavailabilityReason> = new Set([
  "suppliers_cooldown",
  "capacity_saturated",
  "accounts_unhealthy",
]);

/**
 * 開工後的生成預算（2026-09-27 INC-VIDEO-0927）。
 *
 * 影片上游實測比圖片慢一個量級：napi 單次 attempt 最長 993.9s（16.6 分鐘）、
 * 30 秒檔成功單均 868s；adapter 內輪詢窗口原本只有 540s（9 分鐘），
 * 已實錄 1 筆 "openai-video upstream generation timed out after 540s
 * (last status: in_progress)" —— 慢而健康的上游被我們的窗口誤殺。
 * 影片類（video_generate / avatar / lipsync 同為異步影片族）放寬到 25 分鐘
 * （含成品下載與持久化），其餘維持 15 分鐘。
 */
const GENERATION_BUDGET_MS = 15 * 60_000;
const VIDEO_GENERATION_BUDGET_MS = 25 * 60_000;

/** 按任務類型取開工後生成預算（純函數，供測試直接斷言）。 */
export function generationBudgetMs(kind: GenerationKind): number {
  return kind === "video_generate" || kind === "avatar" || kind === "lipsync"
    ? VIDEO_GENERATION_BUDGET_MS
    : GENERATION_BUDGET_MS;
}

/** 排隊順延決策：deadline 快到期 + 未超排隊上限 + 處在可恢復狀態。純邏輯，供測試直接斷言。 */
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
 * 欠費無替補即時失敗（2026-09-28 漫劇評測實錘）：唯一視頻渠道回 401＋insufficient_user_quota
 * 時，registry 只認原生 402 為硬停，job 被放回佇列；帳號進 30 分鐘 cooldown 後再無可租
 * 供應商，單子以 overloaded 空轉到 25 分鐘 deadline 才死——用戶等 25 分鐘只拿到「超時」。
 * 本 job 上一次失敗已判定欠費，且診斷顯示沒有別的可用供應商（全被排除／冷卻／不健康）
 * → 立即失敗＋退款，讓上游如實說「渠道余额不足」。容量滿（capacity_saturated）不算：
 * 那代表還有別的健康供應商在忙，值得等。純邏輯，供測試直接斷言。
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
  return input.lastFailureClass === "quota_exhausted" && EXHAUSTED_SUPPLY_REASONS.has(input.diagnosisReason);
}

/** 病灶 D：把 extend 實際寫入 DB 的 deadline 同步回內存 job.deadlineAt，消除語義漂移。 */
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
    // 心跳失敗只是暫時寫不進 DB，租約到期會自然回收，不值得殺整個進程。
    void heartbeatGenerationJob(job.id, workerId, options.jobLeaseMs, sql).catch((error) => {
      console.error(`[generation-worker] 心跳寫入失敗（非致命） job=${job.id}`, error);
    });
  }, Math.max(1_000, Math.floor(options.jobLeaseMs / 3)));

  try {
    while (completed < job.requestedCount) {
      if (Date.now() >= job.deadlineAt.getTime()) {
        // INC-0831 鐵律：deadline 只代表「我們的等待預算」用完，不代表上游失敗。
        // 有在飛上游任務 → 凍結進對帳（submit_unknown），錢不動，真相由
        // provider-reconciliation 查出來再結算；沒有在飛任務 → 走原誠實失敗+退款。
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
      // 人工取消檢查：job 已 cancelled（或租約易主）→ 停止後續 attempt，
      // 在飛產出丟棄、不調 completeGenerationJob；錢由 reconcileGenerationBilling
      // 對終態 job 按已完成張數 commit、退還差額兜底。
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
        // R7-D：排隊 3 分鐘 deadline 只保護等容量階段；真的租到供應商開工了，
        // 立即按 started_at 展期到生成總預算（慢而健康的影片單不被誤殺）。
        // 病灶 D：extend 返回實際寫入的 deadline，同步回內存 job.deadlineAt，
        // 否則內存仍停在 claim 時的 3 分鐘快照，長任務會被誤殺。
        // INC-VIDEO-0927：預算按 kind 分級（影片 25 分鐘，其餘 15 分鐘）。
        const extendedTo = await extendGenerationDeadlineJob(job, workerId, generationBudgetMs(job.kind), sql).catch(() => null);
        applyExtendedDeadline(job, extendedTo);
      }
      if (!supplierLease) {
        // 診斷為什麼沒租到：同一句 "overloaded" 底下至少有六種完全不同的成因，
        // 處置也完全不同。診斷只在失敗後跑一次，不在熱路徑上。
        // 診斷自身失敗不能蓋掉重試邏輯，所以兜一個保守的說法。
        // 排除鏈（2026-08-29）：把本 job 已失敗過的 supplier / failure domain 與
        // 最近一次上游失敗原文帶進診斷，否則單供應商渠道第一次 attempt 失敗後
        // 必然被自己排除，診斷會謊報「healthy but limits full」。僅失敗路徑多查一次。
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
        if (shouldFailFastOnExhaustedSupply({ lastFailureClass, diagnosisReason: diagnosis.reason })) {
          await failGenerationJob({
            jobId: job.id,
            workerId,
            failureClass: "quota_exhausted",
            failureDetail: `No alternative supplier after upstream balance exhaustion (${diagnosis.reason}): ${lastFailureDetail ?? diagnosis.detail}`,
          }, sql);
          await refundFailure(job, completed, workerId, sql);
          const attemptsAfterFail = await listGenerationAttemptsForJob(job.id, sql).catch(() => jobAttempts);
          await emitJobRoutingEvent({ job, attempts: attemptsAfterFail, outcome: "exhausted", refunded: true });
          return;
        }
        // 病灶 D：排隊期退避撞穿 deadline —— 無 lease 反覆 claim→釋放直到 3 分鐘
        // deadline 到期被 deadline_exceeded 殺單（實錄 12 筆 video job，attempt_count=0）。
        // 當 deadline 快到期且處在「可恢復」的等容量狀態（cooldown 未到 / 併發滿 /
        // 賬號暫掛）時順延一次；純死路（suppliers_disabled / supplier_excluded /
        // 未 seed 等）不延，超過 started_at 起的 20min 排隊上限也不延。
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
        // 心跳失敗只是暫時寫不進 DB，租約到期會自然回收，不值得殺整個進程。
        void heartbeatSupplierLease(supplierLease.id, workerId, options.supplierLeaseMs, sql).catch((error) => {
          console.error(`[generation-worker] 供應商租約心跳失敗（非致命） lease=${supplierLease.id}`, error);
        });
      }, Math.max(1_000, Math.floor(options.supplierLeaseMs / 3)));
      const startedAt = Date.now();
      let attemptId: string | null = null;
      // 剛失敗那次 attempt 的序號（FG-02/03：重放裁決的唯一狀態輸入，非呼叫方預算）。
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
        // INC-0830-VIDEO / INC-0831：適配器在上游提交完成、取得 provider task id 的瞬間
        // 回調 → 先 durably 萬 attempt 行（task id + 對帳排程；事故根治點：只發事件
        // 不落行 = 輪詢斷掉後 task id 無人認領），再落 attempt_submitted 事件（遙測）。
        const onProviderTaskSubmitted = (providerTaskId: string, protocol: ProviderProtocol): void => {
          void markProviderTaskSubmitted({
            jobId: job.id,
            attemptId: attempt.id,
            providerTaskId,
            protocol,
          }, sql).catch((error) => {
            console.error(`[generation-worker] provider task id 落庫失敗（對帳靠失敗路徑兜底） job=${job.id} task=${providerTaskId}`, error);
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
        const output = await generateWithSupplier(supplierLease.supplier, {
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
          // INC-0831：canonical artifact 早已存在（重放/晚到命中冪等鍵）→ 只記 attempt，不重複計數。
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
        // FG-01：先把上游原生錯誤逐字捕獲成版本化記錄（與產品解釋分欄存放），
        // 之後所有落庫路徑共用同一份 record —— 解釋永不覆寫原生欄位。
        const failureRecord = createFailureRecord({ error, explanation: explainFailure(failure) });
        // INC-0830-VIDEO：適配器拋錯時帶出的上游任務 id，回填 attempt 行。
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
          // INC-0831：失敗路徑的 task id 保險回填（提交回調寫入失敗時的兜底；
          // 同 id 冪等，不同 id 不覆蓋）。之後該 attempt 立即進對帳隊列。
          if (failedProviderTaskId) {
            await markProviderTaskSubmitted({
              jobId: job.id,
              attemptId,
              providerTaskId: failedProviderTaskId,
              protocol: protocolOfAdapter(supplierLease.supplier.adapterType),
              firstPollDelayMs: 60_000,
            }, sql).catch((reconcileError) => {
              console.error(`[generation-worker] 失敗路徑 task id 回填失敗 job=${job.id} task=${failedProviderTaskId}`, reconcileError);
            });
          }
          // attempt 失敗事件：upstream_raw = 錯誤原文（不改寫），供 probe 直查死因。
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
        // FG-02/03（2026-09-23）：自動重放許可**只**由封閉 operation registry 裁決
        // （operation-registry.ts）。產品分類（retryable/switchSupplier）不再參與——
        // 分類是關鍵字詞表猜的，餵給錢的決策就是「解釋決定再花一次錢」。
        // 原生硬停（402/400/422/451：確定性失敗，同一個請求換渠道也不可能成功）由 registry
        // 政策宣告，輸入是 FailureRecord.native 的原始 HTTP 狀態，不是產品 category。
        // 402 例外來自暴君 2026-08-29 裁定（fail-fast，立刻誠實失敗＋退款）；改判須暴君點名。
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
          // INC-0831 鐵律：上游已提交的任務不因任何裁決被判死。先凍結進對帳
          //（錢不動），reconciliation 查出上游確認失敗才退款。
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
 * 維護閉環單次執行（Vercel cron 入口用）：runGenerationWorkerOnce 只派單不含維護，
 * cron 進程必須另跑這組（租約回收/計費結算/provider 對帳/健康巡檢），
 * 否則長駐 worker 關停期間對帳就斷糧（INC-0831 教訓：真相查詢不能只有一條心跳）。
 */
export async function runGenerationMaintenanceOnce(options: GenerationWorkerOptions = {}): Promise<void> {
  const sql = options.sql ?? getGenerationSql();
  const executorId = options.workerId
    ? `billing:${options.workerId}`
    : `billing:${process.env.HOSTNAME ?? "local"}:${process.pid}`;
  await recoverExpiredGenerationLeases(sql);
  await reconcileGenerationBilling({ executorId, sql });
  await projectGatePathBilling({ executorId, sql });
  // INC-0831：provider 對帳循環——按 task id 查上游真相，晚到成品落地、
  // 確認失敗才退款、窗口耗盡凍結人工。
  await runProviderReconciliation({ executorId, sql });
  await runAccountMaintenanceOnce(sql);
  await refreshAdobeSupplierHealth(sql);
  await refreshFilmeraSupplierHealth(sql);
  await recoverExpiredCooldowns(sql);
}

/**
 * REQ-E1a/E1b 帳本維護（充值入帳同步 + 跨層對帳）。
 *
 * 節奏刻意與 30s 記帳循環解耦：對帳每個身份一次上游 GET，30s 跑一輪會打爆 new-api。
 * 默認 10 分鐘一次（ACCOUNT_MAINTENANCE_INTERVAL_MS 可調）；兩件事都只讀+冪等寫入，
 * 任何失敗只 console.error（沿用既有告警通道），絕不擋任務路徑。
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
      `[account-ledger] 充值入帳掃描 scanned=${recharges.scanned} charged=${recharges.charged} ` +
        `基線前已補記=${recharges.chargedBaselineAbsorbed} 未使用=${recharges.skippedUnused} ` +
        `基線前漏記=${recharges.skippedBeforeBaseline} ` +
        `訂閱碼=${recharges.skippedSubscription} errors=${recharges.errors.length}`,
    );
  } catch (error) {
    console.error("[account-ledger] 充值入帳失敗（繼續）", error);
  }
  // REQ-D3：訂閱兌換碼 → 期次發放（讀同一份上游兌換記錄；帶 SKU 標記的碼只走這條，
  // 永久充值通道已明確跳過它們）。注意本掃描**不**做「到期清零」——過期是讀取時 lazy
  // 判定的，這裡只處理「有人兌換了訂閱碼」這一個事件。
  try {
    const subscriptions = await ingestSubscriptionRedemptions({}, { sql });
    console.log(
      `[subscription] 訂閱發放掃描 scanned=${subscriptions.scanned} granted=${subscriptions.granted} ` +
        `已發放=${subscriptions.skippedAlreadyGranted} 未使用=${subscriptions.skippedUnused} ` +
        `基線前=${subscriptions.skippedBeforeBaseline} 未註冊SKU=${subscriptions.unknownSku} ` +
        `errors=${subscriptions.errors.length}`,
    );
  } catch (error) {
    console.error("[subscription] 訂閱發放失敗（繼續）", error);
  }
  try {
    const referral = await runReferralRewardsWithSql(sql);
    if (referral.granted || referral.failed || referral.skipped) {
      console.log(`[referral] granted=${referral.granted} skipped=${referral.skipped} failed=${referral.failed}${referral.aborted ? " aborted" : ""}`);
    }
  } catch (error) {
    console.error("[referral] 邀請獎勵失敗（繼續）", error);
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
    console.error("[lifecycle-email] 生命週期郵件失敗（繼續）", error);
  }
  try {
    const report = await reconcileAccountBalances({}, { sql });
    console.log(
      `[account-reconcile] users=${report.totals.users} matched=${report.totals.matched} ` +
        `explained=${report.totals.explained} unseeded=${report.totals.unseeded} ` +
        `unknown=${report.totals.unknown} alerts=${report.alerts.length}`,
    );
  } catch (error) {
    console.error("[account-reconcile] 跨層對帳失敗（繼續）", error);
  }
  return true;
}

export async function runGenerationWorker(options: GenerationWorkerOptions = {}): Promise<void> {
  const sql = options.sql ?? getGenerationSql();
  const pollMs = options.pollMs ?? Number(process.env.GENERATION_WORKER_POLL_MS ?? 1_000);
  // 併發池：舊主循環「租一單同步等到上游跑完再租下一單」，突發任務在第 N 單上
  // 疊加前 N-1 單的上游時長（實錄：metaso 9 連發中控時延 70s→355s 線性增長）。
  // 上游併發上限由 supplier/account/capability 三層 concurrency_limit 在
  // acquireSupplierLease 內把關（SKIP LOCKED，超限走 overloaded 退避重投），
  // 這裡只約束全進程同時在飛的單數，兩層取小值生效。
  const maxInFlight = Math.max(1, options.maxInFlight ?? Number(process.env.GENERATION_WORKER_CONCURRENCY ?? 6));
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let lastMaintenance = 0;
  const billingExecutorId = `billing:${process.env.HOSTNAME ?? "local"}:${process.pid}`;
  // filmera token 輪換持久化：內存換新後原子寫回 env 文件，
  // worker 重啟不丟失 refresh_token 鏈（否則每次重啟都退回舊 token → 401 死鎖）。
  const envPath = process.env.FILMERA_ENV_PATH ?? "/opt/image-control-plane/.env.control-plane";
  onFilmeraTokenRotated(async (next) => {
    try {
      const text = await readFile(envPath, "utf8");
      const lines = text.split("\n").filter((l) => !l.startsWith("FILMERA_AUTH_TOKEN=") && !l.startsWith("FILMERA_REFRESH_TOKEN="));
      lines.push(`FILMERA_AUTH_TOKEN=${next.accessToken}`);
      lines.push(`FILMERA_REFRESH_TOKEN=${next.refreshToken}`);
      // bind-mount 單文件掛載不支援 rename 覆蓋（EBUSY），直接原地寫入。
      // 寫入期間理論上有瞬間不完整窗口，但 env 只在容器啟動時讀取，可接受。
      await writeFile(envPath, lines.join("\n"), "utf8");
      process.env.FILMERA_AUTH_TOKEN = next.accessToken;
      process.env.FILMERA_REFRESH_TOKEN = next.refreshToken;
    } catch (error) {
      console.warn("[generation-worker] filmera token 持久化失敗（僅內存生效）", error instanceof Error ? error.message : String(error));
    }
  });
  const inFlight = new Set<Promise<void>>();
  const dispatch = (job: GenerationJob): void => {
    // finally 的清理改掛 task.finally()：promise 先落 const 才能自引用，
    // settle 後再從 inFlight 摘除，語義與原 finally 塊等價（catch 已吞異常）。
    const task = (async () => {
      try {
        await executeClaimedGenerationJob(job, { ...options, sql });
      } catch (error) {
        // executeGenerationJob 內部已把可預期失敗落成 attempt/fail 鏈；
        // 這裡只兜真正意外的異常，不能讓一單炸掉整個池。
        console.error("[generation-worker] 任務執行意外失敗（繼續輪詢）", error);
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
        // INC-0831：provider 對帳循環——按 task id 查上游真相，晚到成品落地、
        // 確認失敗才退款、窗口耗盡凍結人工。與租約回收同節奏（30s）。
        await runProviderReconciliation({ executorId: billingExecutorId, sql }).catch((error) => {
          console.error("[generation-worker] provider reconciliation failed（繼續）", error);
        });
        // REQ-E1a/E1b：充值入帳同步 + 跨層對帳（內部自帶節奏門檻，非每輪執行）。
        await runAccountMaintenanceOnce(sql);
        await refreshAdobeSupplierHealth(sql);
        await refreshFilmeraSupplierHealth(sql);
        // 病灶 C：cooldown 到期自動恢復（disabled 不自動恢復）。每 30s 與健康循環
        // 一起掃一次，把「cooldown 已到期」的 supplier/account 撿回 healthy。
        await recoverExpiredCooldowns(sql);
        lastMaintenance = now;
      }
      if (inFlight.size < maxInFlight) {
        const job = await claimGenerationJob({ ...options, sql });
        if (job) {
          dispatch(job);
          // 池未滿且仍有積壓：立刻繼續租，讓同一批突發一次拉滿，不空轉等下一個 poll。
          continue;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    } catch (error) {
      // 迭代失敗（暫時性，繼續輪詢）
      console.error("[generation-worker] 迭代失敗（暫時性，繼續輪詢）", error);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  // 停機：不再派新單，等在飛任務收尾（執行鏈自帶租約心跳與退款兜底）。
  await Promise.allSettled(inFlight);
}
