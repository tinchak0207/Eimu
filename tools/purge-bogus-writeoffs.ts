/**
 * 清理誤記的 writeoff 行（2026-08-30）。
 *
 * 背景：billing-projection.ts 的 writeoff 判據 2026-08-30 之前把 4xx（401/403/408/422 等
 * 客戶端被拒，上游零消耗零扣款）也算「真實消耗」寫賬，例如 6adbe3ee/aac89d13 兩筆 401 各記
 * 46 幣假損失。本腳本刪除「按新判據（排除 400-499）本不該寫賬」的 writeoff 行：
 *   該 job 不存在任何 attempt 滿足（有上游記錄 且 非 4xx），
 *   即所有 attempt 都是 4xx，或根本無非 4xx 的上游消耗記錄。
 *
 * 用法（連線串：GENERATION_DATABASE_URL，缺省回退 DATABASE_URL，兼容 postgres://）：
 *   npx tsx tools/purge-bogus-writeoffs.ts                 # dry-run，只印候選
 *   npx tsx tools/purge-bogus-writeoffs.ts --apply         # 真刪
 *   GENERATION_DATABASE_URL=postgres://... npx tsx tools/purge-bogus-writeoffs.ts --apply
 *
 * 冪等：--apply 後重跑候選為 0；只刪 billing_operation operation='writeoff'，不碰其他行。
 */
import { closeGenerationSql, getGenerationSql } from "../src/lib/generation-core/database";
import { generationDatabaseUrl } from "../src/lib/generation-core/database";

interface WriteoffRow {
  id: string;
  job_id: string;
  amount: number;
  created_at: Date;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const apply = args.has("--apply");
  const url = generationDatabaseUrl();
  if (!url) {
    console.error("[purge-bogus-writeoffs] GENERATION_DATABASE_URL (或 DATABASE_URL) 未設定，無法連線 control plane Postgres");
    process.exitCode = 1;
    return;
  }

  const sql = getGenerationSql();
  try {
    const rows = await sql<WriteoffRow[]>`
      SELECT op.id, op.job_id, op.amount, op.created_at
      FROM billing_operation op
      WHERE op.operation = 'writeoff'
        AND NOT EXISTS (
          SELECT 1 FROM generation_attempt attempt
          WHERE attempt.job_id = op.job_id
            AND (attempt.provider_task_id IS NOT NULL OR attempt.provider_http_status IS NOT NULL)
            AND NOT (attempt.provider_http_status IS NOT NULL AND attempt.provider_http_status BETWEEN 400 AND 499)
        )
      ORDER BY op.created_at, op.id
    `;

    if (rows.length === 0) {
      console.log(`[purge-bogus-writeoffs] 0 筆待清（${apply ? "apply" : "dry-run"}）`);
      return;
    }

    console.log(`[purge-bogus-writeoffs] 候選 ${rows.length} 筆（${apply ? "apply：將刪除" : "dry-run：不刪除，加 --apply 才真刪"}）`);
    for (const row of rows) {
      console.log(`  op=${row.id} job=${row.job_id} amount=${row.amount} created_at=${row.created_at.toISOString()}`);
    }

    if (!apply) {
      console.log("[purge-bogus-writeoffs] dry-run 結束。確認後執行：npx tsx tools/purge-bogus-writeoffs.ts --apply");
      return;
    }

    const ids = rows.map((row) => row.id);
    const deleted = await sql`
      DELETE FROM billing_operation
      WHERE id = ANY(${ids})
    `;
    console.log(`[purge-bogus-writeoffs] 已刪除 ${deleted.count} 筆 writeoff`);
  } finally {
    await closeGenerationSql();
  }
}

main().catch((error) => {
  console.error("[purge-bogus-writeoffs] failed", error);
  process.exitCode = 1;
});