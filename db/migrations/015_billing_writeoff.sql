-- 病灶 A（2026-08-30）：0 額閘門路徑 job 打穿上游但 job=failed（真實消耗上游、平台帳面為 0）
-- 需寫入 billing_operation operation='writeoff' 記平台損失（不扣用戶 quota）。
-- 001 的 operation CHECK 只允許 reserve/commit/release/refund，此處放寬納入 writeoff。
-- 行級 inline CHECK 由 Postgres 自動命名為 billing_operation_operation_check，先 DROP 再重建為命名 CHECK。

ALTER TABLE billing_operation
  DROP CONSTRAINT IF EXISTS billing_operation_operation_check;

ALTER TABLE billing_operation
  ADD CONSTRAINT billing_operation_operation_check
  CHECK (operation IN ('reserve', 'commit', 'release', 'refund', 'writeoff'));

-- 投影掃描用 NOT EXISTS (op.operation='writeoff') 判重，partial index 加速。
CREATE INDEX IF NOT EXISTS billing_operation_writeoff_job_idx
  ON billing_operation (job_id)
  WHERE operation = 'writeoff';
