-- 病灶 A（2026-08-30）：0 额闸门路径 job 打穿上游但 job=failed（真实消耗上游、平台帐面为 0）
-- 需写入 billing_operation operation='writeoff' 记平台损失（不扣用户 quota）。
-- 001 的 operation CHECK 只允许 reserve/commit/release/refund，此处放宽纳入 writeoff。
-- 行级 inline CHECK 由 Postgres 自动命名为 billing_operation_operation_check，先 DROP 再重建为命名 CHECK。

ALTER TABLE billing_operation
  DROP CONSTRAINT IF EXISTS billing_operation_operation_check;

ALTER TABLE billing_operation
  ADD CONSTRAINT billing_operation_operation_check
  CHECK (operation IN ('reserve', 'commit', 'release', 'refund', 'writeoff'));

-- 投影扫描用 NOT EXISTS (op.operation='writeoff') 判重，partial index 加速。
CREATE INDEX IF NOT EXISTS billing_operation_writeoff_job_idx
  ON billing_operation (job_id)
  WHERE operation = 'writeoff';
