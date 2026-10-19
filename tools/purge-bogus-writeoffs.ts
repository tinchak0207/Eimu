/**
 * 清理误记的 writeoff 行（2026-08-30）。
 *
 * 背景：billing-projection.ts 的 writeoff 判据 2026-08-30 之前把 4xx（401/403/408/422 等
 * 客户端被拒，上游零消耗零扣款）也算「真实消耗」写账，例如 6adbe3ee/aac89d13 两笔 401 各记
 * 46 币假损失。本脚本删除「按新判据（排除 400-499）本不该写账」的 writeoff 行：
 *   该 job 不存在任何 attempt 满足（有上游记录 且 非 4xx），
 *   即所有 attempt 都是 4xx，或根本无非 4xx 的上游消耗记录。
 *
 * 用法（连线串：GENERATION_DATABASE_URL，缺省回退 DATABASE_URL，兼容 postgres://）：
 *   npx tsx tools/purge-bogus-writeoffs.ts                 # dry-run，只印候选
 *   npx tsx tools/purge-bogus-writeoffs.ts --apply         # 真删
 *   GENERATION_DATABASE_URL=postgres://... npx tsx tools/purge-bogus-writeoffs.ts --apply
 *
 * 幂等：--apply 后重跑候选为 0；只删 billing_operation operation='writeoff'，不碰其他行。
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
    console.error("[purge-bogus-writeoffs] GENERATION_DATABASE_URL (或 DATABASE_URL) 未设定，无法连线 control plane Postgres");
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
      console.log(`[purge-bogus-writeoffs] 0 笔待清（${apply ? "apply" : "dry-run"}）`);
      return;
    }

    console.log(`[purge-bogus-writeoffs] 候选 ${rows.length} 笔（${apply ? "apply：将删除" : "dry-run：不删除，加 --apply 才真删"}）`);
    for (const row of rows) {
      console.log(`  op=${row.id} job=${row.job_id} amount=${row.amount} created_at=${row.created_at.toISOString()}`);
    }

    if (!apply) {
      console.log("[purge-bogus-writeoffs] dry-run 结束。确认后执行：npx tsx tools/purge-bogus-writeoffs.ts --apply");
      return;
    }

    const ids = rows.map((row) => row.id);
    const deleted = await sql`
      DELETE FROM billing_operation
      WHERE id = ANY(${ids})
    `;
    console.log(`[purge-bogus-writeoffs] 已删除 ${deleted.count} 笔 writeoff`);
  } finally {
    await closeGenerationSql();
  }
}

main().catch((error) => {
  console.error("[purge-bogus-writeoffs] failed", error);
  process.exitCode = 1;
});