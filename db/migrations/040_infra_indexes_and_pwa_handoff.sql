-- expand-only。不 ALTER 已有 user_id / billing_user_id 列类型（生产列改类型会重写大表）。
-- integer / bigint 不一致，跨表 JOIN 可能触发隐式转换、索引用不上。本文件只记录，不改列：
--   integer:
--     account_ledger.billing_user_id
--     account_ledger.counterparty_user_id
--     subscription.billing_user_id
--     biz_api_key.user_id
--     team_member_quota.team_user_id
--     team_member_quota.member_user_id
--     team_settings.team_user_id
--     team_join_request.team_user_id
--     team_join_request.applicant_user_id
--     team_join_request.decided_by_user_id
--   bigint:
--     generation_job.billing_user_id
--     lora_user_state.user_id
--     welcome_gift_grant.user_id
--     user_attribution.user_id
--     email_send_log.user_id
--     email_preference.user_id
--     api_rejection.user_id
--     mapay_credit.user_id
--     first_charge_claim.user_id
--     admin_account_adjustment.user_id
--     mapay_order_intake.user_id
-- 上述 bigint 表的 CREATE TABLE 已在 001/006/024/025/027/029/030/031/035/037。
-- 运行时 ensureSchema 仍可能在迁移落地前被旧进程调用，故那些文件保留进程内一次 DDL。
-- 本迁移补上此前只存在于 src/lib/pwa-handoff.ts 的表。

CREATE TABLE IF NOT EXISTS pwa_login_handoff (
  ticket       TEXT PRIMARY KEY,
  token        TEXT NOT NULL DEFAULT '',
  user_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  delivered_at TIMESTAMPTZ,
  claimed_at   TIMESTAMPTZ
);

-- 对应 DELETE FROM pwa_login_handoff WHERE expires_at < now() - interval '1 day'
CREATE INDEX IF NOT EXISTS pwa_login_handoff_expires_at_idx
  ON pwa_login_handoff (expires_at);

-- generation_job.billing_user_id 现有类型是 bigint，索引按列原类型创建，不做 cast。
CREATE INDEX IF NOT EXISTS generation_job_billing_user_status_idx
  ON generation_job (billing_user_id, status);
