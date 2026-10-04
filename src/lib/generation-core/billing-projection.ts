import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import { adjustGatewayUserQuotaExact } from "@/lib/gateway-admin";
import { imageGenerationCoins } from "@/lib/provider-config";
import { generationCoins } from "@/lib/generation-model-catalog/pricing";
import { ttsQuotaForChars } from "@/lib/generation-model-catalog/tts-pricing";
import { syncModelPricing } from "@/lib/pricing-runtime";
import { getGenerationSql, type GenerationSql } from "./database";
import { ensureAccountBaselines, recordConsumption } from "./account-ledger";
import { emitJobEvent } from "./job-events";
import { billingReplayDenialDetail, planBillingAttemptReplay } from "./operation-registry";
import { randomUUID } from "node:crypto";

/**
 * P1 记帐投影（2026-08-28 手术）：闸门路径（SURGERY_QUOTA_PRECHECK=1，billing_amount=0）
 * 的 succeeded job 由本投影记帐——金额=与 incumbent 相同的确定性定价重算（同一批定价
 * 函数、同一入口，不发明新价格），扣减 new-api users.quota（唯一真源），落
 * billing_operation commit 行（idempotency_ref=projection:{job}:commit:1 防重防并发），
 * 事件账本记 billing_committed（detail.projection=true 供 probe 归因）。
 *
 * 铁律：投影永不挡任务路径（遥测两铁律：可以晚到，不可以不写；不挡路）——任何失败只
 * console.error，claim 行置 failed + last_error 原文，不盲目重放；probe stuck 面
 * （terminal_unsettled）如实可见。
 *
 * 金额语义：与 incumbent commit 相同的 base 定价；按上游真实消耗（new-api logs type=2）
 * 归因属后续精化，不在本投影发明。
 */

const PROJECTION_BATCH_DEFAULT = 50;

/**
 * 投影的 commit 尝试序号：claim 行以 attempt_count=1 落库（见下方 INSERT），
 * 故第 1 次＝1；扣款失败后要问的重放授权是第 `PROJECTION_COMMIT_ATTEMPT_NO + 1` 次。
 * （FG 教训：接 registry 前先把序号语义钉死，差一格就会多／少重放一次。）
 */
const PROJECTION_COMMIT_ATTEMPT_NO = 1;

type Row = Record<string, unknown>;

interface GatePathJobRow {
  id: string;
  kind: string;
  model_id: string;
  quality: string | null;
  resolution: string | null;
  requested_count: number;
  workflow_json: unknown;
  billing_user_id: number;
}

export interface BillingProjectionSummary {
  claimed: number;
  projected: number;
  failed: number;
  skippedUnknownPrice: number;
  writeoffs: number;
}

/** 与 incumbent 完全同源的确定性定价重算；无法确定 = 0（上层跳过并记录，不猜）。 */
export function estimateGatePathBasePrice(row: GatePathJobRow): number {
  const count = Math.max(1, Number(row.requested_count) || 1);
  try {
    if (row.kind === "image_generate") {
      const coins = imageGenerationCoins(row.model_id, (row.quality as "fast" | "quality") ?? "fast");
      return Math.round(coins * QUOTA_PER_COIN) * count;
    }
    if (row.kind === "video_generate") {
      const workflow = (row.workflow_json && typeof row.workflow_json === "object" ? row.workflow_json : {}) as {
        durationSeconds?: number;
        generateAudio?: boolean;
      };
      const coins = generationCoins(row.model_id, {
        resolution: (row.resolution ?? undefined) as never,
        durationSeconds: workflow.durationSeconds,
        generateAudio: workflow.generateAudio,
      } as never);
      return Math.round(coins * QUOTA_PER_COIN) * count;
    }
    // TTS（2026-10-01 接入逐字计费）：闸门路径（billing_amount=0）的 succeeded tts job
    // 由投影补记帐。金额＝提交时已落库的 `workflow.inputLength`（请求文本实际字数，
    // 提交端写入的真源；缺此栏位的旧单 → NaN → 0 → 如实跳过并记 skippedUnknownPrice，
    // 不猜字数）逐字计价，与 /v1/tts/generations 的 baseBillingAmount 同源同价。
    // 不乘 count：`inputLength` 已是整段文本字数，`requestedCount` 对 TTS 恒为 1。
    if (row.kind === "tts") {
      const workflow = (row.workflow_json && typeof row.workflow_json === "object" ? row.workflow_json : {}) as {
        inputLength?: number;
      };
      return ttsQuotaForChars(Number(workflow.inputLength));
    }
  } catch {
    return 0;
  }
  return 0;
}

/**
 * 扫描闸门路径终态 job 并记帐。幂等：非零 commit 行存在即跳过；claim 行
 * （pending → applied/failed）防多 worker 并发双扣。
 */
export async function projectGatePathBilling(input: {
  executorId: string;
  limit?: number;
  sql?: GenerationSql;
}): Promise<BillingProjectionSummary> {
  const sql = input.sql ?? getGenerationSql();
  const limit = Math.max(1, Math.min(input.limit ?? PROJECTION_BATCH_DEFAULT, 200));
  const summary: BillingProjectionSummary = { claimed: 0, projected: 0, failed: 0, skippedUnknownPrice: 0, writeoffs: 0 };

  // 先同步 admin 定价覆写层再重算：覆写层是价格真相（改价即生效），worker 进程不同步
  // 就会拿烘焙基准价记账——2026-08-28 pixai 3000 倍多扣（1,500,000 vs 500 quota）的根因。
  // 永不抛错：sync 失败沿用当前生效值，不挡记帐。
  await syncModelPricing();

  let rows: GatePathJobRow[];
  try {
    rows = await sql<GatePathJobRow[]>`
      SELECT job.id, job.kind, job.model_id, job.quality, job.resolution, job.requested_count, job.workflow_json, job.billing_user_id
      FROM generation_job job
      WHERE job.status = 'succeeded'
        AND job.billing_amount = 0
        AND job.billing_user_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM billing_operation op
          WHERE op.job_id = job.id AND op.operation = 'commit' AND op.amount > 0
        )
      ORDER BY job.finished_at NULLS LAST
      LIMIT ${limit}
    `;
  } catch (error) {
    console.error("[billing-projection] scan failed (不挡路，下一轮重试)", error);
    return summary;
  }

  for (const row of rows) {
    const jobId = String(row.id);
    try {
      const amount = estimateGatePathBasePrice(row);
      if (amount <= 0) {
        summary.skippedUnknownPrice += 1;
        console.error(`[billing-projection] skip job ${jobId}: cannot determine base price (kind=${row.kind} model=${row.model_id})`);
        continue;
      }

      const claimed = await sql<Row[]>`
        INSERT INTO billing_operation (id, job_id, operation, sequence, amount, status, idempotency_ref, executor_id, attempt_count)
        VALUES (${randomUUID()}, ${jobId}, 'commit', 1, ${amount}, 'pending', ${`projection:${jobId}:commit:1`}, ${input.executorId}, 1)
        ON CONFLICT (idempotency_ref) DO NOTHING
        RETURNING id
      `;
      if (!claimed[0]) continue; // 已投影或另一 worker 并发认领
      summary.claimed += 1;

      // REQ-E1a 顺序铁律：先种基线（取「扣款之前」的 users.quota），再扣上游，最后记帐本。
      // 先扣后种 = 基线已含这笔扣款 + 帐本再记一次 = 双算。
      const baselineReady = await ensureAccountBaselines([Number(row.billing_user_id)], { sql });
      try {
        await adjustGatewayUserQuotaExact(Number(row.billing_user_id), -amount);
      } catch (error) {
        // FG-b：这是 billing.commit 的重放裁决点。扣款失败后唯一该问的问题是
        // 「还准不准再试一次」——答案只能来自封闭 operation registry。
        // 第 1 次已执行（上面 claim 行的 attempt_count=1），故此处问第 2 次：
        // 政策 maxReplayAttempts=1 ⇒ 必然拒绝，claim 终结为 failed 并把拒绝理由原文
        // 写进 last_error。**不在这里发明重放**：上游对 quota 调整没有幂等契约，
        // 重放同一笔扣款可能双扣（见 billing-ledger 的 classifyBillingFailure 注解）。
        const failureDetail = (error instanceof Error ? error.message : String(error)).slice(0, 250);
        const replay = planBillingAttemptReplay({
          operation: "billing.commit",
          nextAttemptNo: PROJECTION_COMMIT_ATTEMPT_NO + 1,
        });
        const reason = replay.allowed
          ? `${failureDetail} | registry allows a commit replay but no replay path is implemented; claim frozen for manual reconciliation.`
          : `${failureDetail} | ${billingReplayDenialDetail("billing.commit", replay)}`;
        await sql`
          UPDATE billing_operation SET status = 'failed', last_error = ${reason.slice(0, 500)}, updated_at = now()
          WHERE id = ${String(claimed[0].id)} AND status = 'pending'
        `;
        emitJobEvent({
          jobId,
          event: "replay_denied",
          actor: input.executorId,
          upstreamRaw: failureDetail,
          detail: {
            operation: "billing.commit",
            denial_reason: replay.allowed ? "replay_path_unimplemented" : replay.denialReason,
            attempt_no: replay.nextAttemptNo,
            max_replay_attempts: replay.maxReplayAttempts,
            billing_operation: "commit",
            projection: true,
          },
        }, sql);
        summary.failed += 1;
        console.error(`[billing-projection] job ${jobId}: users.quota debit failed, claim marked failed: ${reason}`);
        continue;
      }

      await sql`
        UPDATE billing_operation SET status = 'applied', applied_at = now(), updated_at = now()
        WHERE id = ${String(claimed[0].id)} AND status = 'pending'
      `;
      summary.projected += 1;
      emitJobEvent({ jobId, event: "billing_committed", actor: input.executorId, detail: { projection: true, amount } });
      // REQ-E1a 双写：上游 users.quota 的这笔扣减同步记进我方帐本（余额权威）。
      // 记帐失败不挡路（recordConsumption 内部吞掉并回报 false），差额由 E1b 对帐报告指出。
      const ledger = baselineReady
        ? await recordConsumption({
            billingUserId: Number(row.billing_user_id),
            amountQuota: amount,
            jobId,
            operationId: String(claimed[0].id),
            source: "billing-projection",
          }, { sql })
        : { posted: false, reason: "基线不可得（未记帐）" };
      if (!ledger.posted) {
        console.error(`[billing-projection] job ${jobId}: 帐本同步未落地（${ledger.reason}）——已由对帐报告负责`);
      }
      console.log(`[billing-projection] job ${jobId}: projected ${amount} (users.quota debited, ledger committed)`);
    } catch (error) {
      console.error(`[billing-projection] job ${jobId}: projection error (不挡路)`, error);
    }
  }

  // 病灶 A 分支（2026-08-30）：0 额闸门路径 job 照样被 worker 提交上游，若最后 failed，
  // succeeded 分支永远不会记帐——平台帐面 0、上游已真扣（如 seedance-2.5-720p 单笔 ¥2.95）。
  // 这里只把平台真实损失写入 writeoff 帐本，不扣用户 quota（用户没拿到交付物）。
  // 判据：status='failed' AND billing_amount=0 AND 有 submitted 过上游的 attempt
  // （provider_task_id / provider_http_status 任一非空），且尚无 writeoff 行。
  // 收紧（2026-08-30）：provider_http_status 在 400-499（401/403/408/422 等客户端被拒）一律不写账
  // ——上游零消耗零扣款，虚记 = 假账（如 6adbe3ee/aac89d13 两笔 401 各记 46 币实为假损失）。
  // 按保守原则 4xx 全排除：漏记时上游本就没扣 = 无真损失；虚记才是损害。NULL / 5xx / 2xx 保留。
  let writeoffRows: GatePathJobRow[];
  try {
    writeoffRows = await sql<GatePathJobRow[]>`
      SELECT job.id, job.kind, job.model_id, job.quality, job.resolution, job.requested_count, job.workflow_json, job.billing_user_id
      FROM generation_job job
      WHERE job.status = 'failed'
        AND job.billing_amount = 0
        AND job.billing_user_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM generation_attempt attempt
          WHERE attempt.job_id = job.id
            AND (attempt.provider_task_id IS NOT NULL OR attempt.provider_http_status IS NOT NULL)
            AND NOT (attempt.provider_http_status IS NOT NULL AND attempt.provider_http_status BETWEEN 400 AND 499)
        )
        AND NOT EXISTS (
          SELECT 1 FROM billing_operation op
          WHERE op.job_id = job.id AND op.operation = 'writeoff'
        )
      ORDER BY job.finished_at NULLS LAST
      LIMIT ${limit}
    `;
  } catch (error) {
    console.error("[billing-projection] writeoff scan failed (不挡路，下一轮重试)", error);
    return summary;
  }

  for (const row of writeoffRows) {
    const jobId = String(row.id);
    try {
      const amount = estimateGatePathBasePrice(row);
      if (amount <= 0) {
        summary.skippedUnknownPrice += 1;
        console.error(`[billing-projection] writeoff skip job ${jobId}: cannot determine base price (kind=${row.kind} model=${row.model_id})`);
        continue;
      }

      const claimed = await sql<Row[]>`
        INSERT INTO billing_operation (id, job_id, operation, sequence, amount, status, idempotency_ref, executor_id, attempt_count)
        VALUES (${randomUUID()}, ${jobId}, 'writeoff', 1, ${amount}, 'applied', ${`projection:${jobId}:writeoff:1`}, ${input.executorId}, 1)
        ON CONFLICT (idempotency_ref) DO NOTHING
        RETURNING id
      `;
      if (!claimed[0]) continue; // 已写过或另一 worker 并发认领
      summary.writeoffs += 1;
      emitJobEvent({ jobId, event: "billing_writeoff", actor: input.executorId, detail: { projection: true, amount, reason: "failed_with_upstream_consumption" } }, sql);
      console.log(`[billing-projection] job ${jobId}: wrote off ${amount} (failed with upstream consumption; no user debit)`);
    } catch (error) {
      console.error(`[billing-projection] job ${jobId}: writeoff error (不挡路)`, error);
    }
  }

  return summary;
}
