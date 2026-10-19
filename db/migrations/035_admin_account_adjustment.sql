-- 035: admin_account_adjustment —— 管理员调额占位表（src/lib/admin-account-adjustment.ts）。
--
-- 取代「在 new-api SQLite 手写 redemptions 假行 + UPDATE users.quota，再等 worker 同步」。
-- 不是帐本：金额的权威记录仍是 account_ledger 的 adjustment 行
-- （idempotency_ref = 'adjustment:admin-adjust:<idempotency_key>'）。本表只解决：
-- 上游 new-api 调额（/api/user/manage add_quota）本身不幂等，必须在动上游之前先按
-- Idempotency-Key 占位，保证同一个键永远只调一次额；同键换 user/金额 ⇒ 409。
--
-- 状态机：pending（已占位，不自动重试）→ applied（上游已调额）
--                                      → failed（上游明确没动/基线不可得，同一笔可重新占位）
--                                      → unknown（上游结果不明，不自动重试，人工核对）
-- 运行时首用会 CREATE TABLE IF NOT EXISTS 同一 DDL，本文件为留档与手工建表用。

CREATE TABLE IF NOT EXISTS admin_account_adjustment (
  idempotency_key text PRIMARY KEY,
  source_ref      text NOT NULL UNIQUE,
  user_id         bigint NOT NULL,
  amount_quota    bigint NOT NULL CHECK (amount_quota <> 0),
  operator        text NOT NULL,
  note            text NOT NULL,
  status          text NOT NULL CHECK (status IN ('pending', 'applied', 'failed', 'unknown')),
  detail          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_account_adjustment_user_idx
  ON admin_account_adjustment (user_id, created_at DESC);
