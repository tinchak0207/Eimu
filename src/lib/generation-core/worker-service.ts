import { randomUUID } from "node:crypto";
import { commitGenerationBilling, reconcileGenerationBilling, refundGenerationBilling } from "./billing-ledger";
import { decryptGenerationPrompt } from "./crypto";
import { getGenerationSql, type GenerationSql } from "./database";
import { classifySupplierFailure } from "./failure-classifier";
import { persistOutputArtifact } from "./artifact-service";
import {
  attemptedSupplierRoutingForOutput,
  beginGenerationAttempt,
  claimNextGenerationJob,
  completeGenerationAttempt,
  completeGenerationJob,
  failGenerationAttempt,
  failGenerationJob,
  heartbeatGenerationJob,
  listCompletedGenerationArtifacts,
  listGenerationAttemptsForJob,
  recoverExpiredGenerationLeases,
  releaseJobForRetry,
} from "./job-repository";
import { acquireSupplierLease, diagnoseSupplierUnavailability, heartbeatSupplierLease, releaseSupplierLease, reportSupplierFailure, reportSupplierSuccess } from "./scheduler";
import { generateWithSupplier } from "./supplier-adapter";
import type { GenerationArtifactResult, GenerationJob } from "./types";
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
  sql?: GenerationSql;
}

function backoffMs(attemptCount: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.min(6, attemptCount));
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
        await failGenerationJob({ jobId: job.id, workerId, failureClass: "deadline_exceeded", failureDetail: "Generation deadline elapsed before all outputs completed." }, sql);
        await refundFailure(job, completed, workerId, sql);
        const jobAttempts = await listGenerationAttemptsForJob(job.id, sql);
        await emitJobRoutingEvent({ job, attempts: jobAttempts, outcome: "exhausted", refunded: true });
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
      if (!supplierLease) {
        // 診斷為什麼沒租到：同一句 "overloaded" 底下至少有六種完全不同的成因，
        // 處置也完全不同。診斷只在失敗後跑一次，不在熱路徑上。
        // 診斷自身失敗不能蓋掉重試邏輯，所以兜一個保守的說法。
        const diagnosis = await diagnoseSupplierUnavailability(job, sql).catch(() => ({
          reason: "capacity_saturated" as const,
          detail: "No eligible supplier capacity is currently available.",
        }));
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
      try {
        const attempt = await beginGenerationAttempt({
          jobId: job.id,
          workerId,
          supplierId: supplierLease.supplier.id,
          supplierModelId: supplierLease.supplier.supplierModelId,
          outputIndex: completed,
        }, sql);
        attemptId = attempt.id;
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
        if (attemptId) {
          await failGenerationAttempt({
            jobId: job.id,
            workerId,
            attemptId,
            failureClass: failure.failureClass,
            failureDetail: failure.detail,
            providerHttpStatus: failure.httpStatus,
            retryAfterAt: failure.cooldownUntil,
            latencyMs: Date.now() - startedAt,
          }, sql);
        }
        await reportSupplierFailure({
          supplierId: supplierLease.supplier.id,
          accountId: supplierLease.supplier.account.id,
          capabilityId: supplierLease.supplier.capabilityId,
        }, failure, sql);
        if (!failure.retryable || !failure.switchSupplier) {
          await failGenerationJob({ jobId: job.id, workerId, failureClass: failure.failureClass, failureDetail: failure.detail }, sql);
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

/** Claim and process at most one job. Exported for deterministic integration tests. */
export async function runGenerationWorkerOnce(options: GenerationWorkerOptions = {}): Promise<boolean> {
  const sql = options.sql ?? getGenerationSql();
  const workerId = options.workerId ?? `worker:${process.env.HOSTNAME ?? "local"}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const jobLeaseMs = options.jobLeaseMs ?? Number(process.env.GENERATION_JOB_LEASE_MS ?? 120_000);
  const supplierLeaseMs = options.supplierLeaseMs ?? Number(process.env.GENERATION_SUPPLIER_LEASE_MS ?? 120_000);
  const job = await claimNextGenerationJob(workerId, jobLeaseMs, sql);
  if (!job) return false;
  await executeGenerationJob(job, workerId, { jobLeaseMs, supplierLeaseMs }, sql);
  return true;
}

export async function runGenerationWorker(options: GenerationWorkerOptions = {}): Promise<void> {
  const sql = options.sql ?? getGenerationSql();
  const pollMs = options.pollMs ?? Number(process.env.GENERATION_WORKER_POLL_MS ?? 1_000);
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
  while (!stopping) {
    try {
      const now = Date.now();
      if (now - lastMaintenance > 30_000) {
        await recoverExpiredGenerationLeases(sql);
        await reconcileGenerationBilling({ executorId: billingExecutorId, sql });
        await refreshAdobeSupplierHealth(sql);
        await refreshFilmeraSupplierHealth(sql);
        lastMaintenance = now;
      }
      const processed = await runGenerationWorkerOnce({ ...options, sql });
      if (!processed) await new Promise((resolve) => setTimeout(resolve, pollMs));
    } catch (error) {
      // 迭代失敗（暫時性，繼續輪詢）
      console.error("[generation-worker] 迭代失敗（暫時性，繼續輪詢）", error);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}
