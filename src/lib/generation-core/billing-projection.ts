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
 * P1 記帳投影（2026-08-28 手術）：閘門路徑（SURGERY_QUOTA_PRECHECK=1，billing_amount=0）
 * 的 succeeded job 由本投影記帳——金額=與 incumbent 相同的確定性定價重算（同一批定價
 * 函數、同一入口，不發明新價格），扣減 new-api users.quota（唯一真源），落
 * billing_operation commit 行（idempotency_ref=projection:{job}:commit:1 防重防併發），
 * 事件賬本記 billing_committed（detail.projection=true 供 probe 歸因）。
 *
 * 鐵律：投影永不擋任務路徑（遙測兩鐵律：可以晚到，不可以不寫；不擋路）——任何失敗只
 * console.error，claim 行置 failed + last_error 原文，不盲目重放；probe stuck 面
 * （terminal_unsettled）如實可見。
 *
 * 金額語義：與 incumbent commit 相同的 base 定價；按上游真實消耗（new-api logs type=2）
 * 歸因屬後續精化，不在本投影發明。
 */

const PROJECTION_BATCH_DEFAULT = 50;

/**
 * 投影的 commit 嘗試序號：claim 行以 attempt_count=1 落庫（見下方 INSERT），
 * 故第 1 次＝1；扣款失敗後要問的重放授權是第 `PROJECTION_COMMIT_ATTEMPT_NO + 1` 次。
 * （FG 教訓：接 registry 前先把序號語義釘死，差一格就會多／少重放一次。）
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

/** 與 incumbent 完全同源的確定性定價重算；無法確定 = 0（上層跳過並記錄，不猜）。 */
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
    // TTS（2026-10-01 接入逐字計費）：閘門路徑（billing_amount=0）的 succeeded tts job
    // 由投影補記帳。金額＝提交時已落庫的 `workflow.inputLength`（請求文本實際字數，
    // 提交端寫入的真源；缺此欄位的舊單 → NaN → 0 → 如實跳過並記 skippedUnknownPrice，
    // 不猜字數）逐字計價，與 /v1/tts/generations 的 baseBillingAmount 同源同價。
    // 不乘 count：`inputLength` 已是整段文本字數，`requestedCount` 對 TTS 恆為 1。
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
 * 掃描閘門路徑終態 job 並記帳。冪等：非零 commit 行存在即跳過；claim 行
 * （pending → applied/failed）防多 worker 併發雙扣。
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
  // 永不拋錯：sync 失敗沿用當前生效值，不擋記帳。
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
    console.error("[billing-projection] scan failed (不擋路，下一輪重試)", error);
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
      if (!claimed[0]) continue; // 已投影或另一 worker 併發認領
      summary.claimed += 1;

      // REQ-E1a 順序鐵律：先種基線（取「扣款之前」的 users.quota），再扣上游，最後記帳本。
      // 先扣後種 = 基線已含這筆扣款 + 帳本再記一次 = 雙算。
      const baselineReady = await ensureAccountBaselines([Number(row.billing_user_id)], { sql });
      try {
        await adjustGatewayUserQuotaExact(Number(row.billing_user_id), -amount);
      } catch (error) {
        // FG-b：這是 billing.commit 的重放裁決點。扣款失敗後唯一該問的問題是
        // 「還准不准再試一次」——答案只能來自封閉 operation registry。
        // 第 1 次已執行（上面 claim 行的 attempt_count=1），故此處問第 2 次：
        // 政策 maxReplayAttempts=1 ⇒ 必然拒絕，claim 終結為 failed 並把拒絕理由原文
        // 寫進 last_error。**不在這裡發明重放**：上游對 quota 調整沒有冪等契約，
        // 重放同一筆扣款可能雙扣（見 billing-ledger 的 classifyBillingFailure 註解）。
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
      // REQ-E1a 雙寫：上游 users.quota 的這筆扣減同步記進我方帳本（餘額權威）。
      // 記帳失敗不擋路（recordConsumption 內部吞掉並回報 false），差額由 E1b 對帳報告指出。
      const ledger = baselineReady
        ? await recordConsumption({
            billingUserId: Number(row.billing_user_id),
            amountQuota: amount,
            jobId,
            operationId: String(claimed[0].id),
            source: "billing-projection",
          }, { sql })
        : { posted: false, reason: "基線不可得（未記帳）" };
      if (!ledger.posted) {
        console.error(`[billing-projection] job ${jobId}: 帳本同步未落地（${ledger.reason}）——已由對帳報告負責`);
      }
      console.log(`[billing-projection] job ${jobId}: projected ${amount} (users.quota debited, ledger committed)`);
    } catch (error) {
      console.error(`[billing-projection] job ${jobId}: projection error (不擋路)`, error);
    }
  }

  // 病灶 A 分支（2026-08-30）：0 額閘門路徑 job 照樣被 worker 提交上游，若最後 failed，
  // succeeded 分支永遠不會記帳——平台帳面 0、上游已真扣（如 seedance-2.5-720p 單筆 ¥2.95）。
  // 這裡只把平台真實損失寫入 writeoff 帳本，不扣用戶 quota（用戶沒拿到交付物）。
  // 判據：status='failed' AND billing_amount=0 AND 有 submitted 過上游的 attempt
  // （provider_task_id / provider_http_status 任一非空），且尚無 writeoff 行。
  // 收緊（2026-08-30）：provider_http_status 在 400-499（401/403/408/422 等客戶端被拒）一律不寫賬
  // ——上游零消耗零扣款，虛記 = 假賬（如 6adbe3ee/aac89d13 兩筆 401 各記 46 幣實為假損失）。
  // 按保守原則 4xx 全排除：漏記時上游本就沒扣 = 無真損失；虛記才是損害。NULL / 5xx / 2xx 保留。
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
    console.error("[billing-projection] writeoff scan failed (不擋路，下一輪重試)", error);
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
      if (!claimed[0]) continue; // 已寫過或另一 worker 併發認領
      summary.writeoffs += 1;
      emitJobEvent({ jobId, event: "billing_writeoff", actor: input.executorId, detail: { projection: true, amount, reason: "failed_with_upstream_consumption" } }, sql);
      console.log(`[billing-projection] job ${jobId}: wrote off ${amount} (failed with upstream consumption; no user debit)`);
    } catch (error) {
      console.error(`[billing-projection] job ${jobId}: writeoff error (不擋路)`, error);
    }
  }

  return summary;
}
