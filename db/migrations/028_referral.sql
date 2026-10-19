-- 028: 邀请奖励（src/lib/referral-reward.ts）。
--
-- referral_binding：被邀请人 → 邀请人。只在被邀请人尚未成功出图时写入，首个邀请胜出。
-- referral_reward：每个被邀请人两行（inviter / invitee），与新人礼同一套占位状态机；
--   金额的权威记录仍是 account_ledger 的 adjustment 行（source = 'referral'）。
-- 运行时首用会 CREATE TABLE IF NOT EXISTS 同一 DDL，本文件为留档与手工建表用。

CREATE TABLE IF NOT EXISTS referral_binding (
  invitee_id bigint PRIMARY KEY,
  inviter_id bigint NOT NULL,
  bound_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (invitee_id <> inviter_id)
);
CREATE INDEX IF NOT EXISTS referral_binding_inviter_idx ON referral_binding (inviter_id);

CREATE TABLE IF NOT EXISTS referral_reward (
  invitee_id      bigint NOT NULL,
  role            text NOT NULL CHECK (role IN ('inviter', 'invitee')),
  beneficiary_id  bigint NOT NULL,
  inviter_id      bigint NOT NULL,
  idempotency_ref text NOT NULL UNIQUE,
  amount_quota    bigint NOT NULL,
  status          text NOT NULL CHECK (status IN ('pending', 'applied', 'failed', 'unknown', 'skipped')),
  detail          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (invitee_id, role)
);
