-- 024: welcome_gift_grant —— 新人礼占位表（src/lib/welcome-gift.ts）。
--
-- 不是帐本：金额的权威记录仍是 account_ledger 的 adjustment 行
-- （idempotency_ref = 'adjustment:welcome:<uid>:v1'）。本表只解决一件事：上游
-- new-api 调额（/api/user/manage add_quota）本身不幂等，必须在动上游之前先占位，
-- 保证同一用户永远只加一次额。
--
-- 状态机：pending（已占位，不自动重试）→ applied（上游已加额）
--                                      → failed（上游明确没动，允许重新占位）
--                                      → unknown（上游结果不明，不自动重试，人工核对）
-- noticed_at：站内通知已送达的回执（Vercel 登录路径写完通知后经 op=noticed 回填）。
-- 运行时首用会 CREATE TABLE IF NOT EXISTS 同一 DDL，本文件为留档与手工建表用。

CREATE TABLE IF NOT EXISTS welcome_gift_grant (
  user_id         bigint PRIMARY KEY,
  idempotency_ref text NOT NULL UNIQUE,
  amount_quota    bigint NOT NULL CHECK (amount_quota > 0),
  status          text NOT NULL CHECK (status IN ('pending', 'applied', 'failed', 'unknown')),
  detail          text,
  noticed_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
