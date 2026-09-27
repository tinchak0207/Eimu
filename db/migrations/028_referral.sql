-- 028: 邀請獎勵（src/lib/referral-reward.ts）。
--
-- referral_binding：被邀請人 → 邀請人。只在被邀請人尚未成功出圖時寫入，首個邀請勝出。
-- referral_reward：每個被邀請人兩行（inviter / invitee），與新人禮同一套佔位狀態機；
--   金額的權威記錄仍是 account_ledger 的 adjustment 行（source = 'referral'）。
-- 運行時首用會 CREATE TABLE IF NOT EXISTS 同一 DDL，本文件為留檔與手工建表用。

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
