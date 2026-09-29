-- 031: first_charge_claim —— 首充专享档（plan id `first-charge`，¥7 得 300 币）的名额表
-- （src/lib/first-charge.ts）。
--
-- 不是帐本：金额的权威记录仍是 account_ledger 的 recharge 行
-- （idempotency_ref = 'redemption:<out_trade_no>'，来源 redemption-sync = 现金营收）。
-- 本表只回答两件事：
--   ①「这个帐号的首充名额被哪张单占了」——user_id 是主键，等于「每帐号限一次」的并发
--     执法点（INSERT … ON CONFLICT (user_id) DO NOTHING RETURNING，与新人礼同一手法）；
--   ②该名额是按全额（300 币）发的。资格判准的另一半（该帐号在 account_ledger 有没有
--     recharge 行）直接读帐本，不在本表冗余存储。
--
-- 资格不符（例如并发下了两单）时不给 300，按 ¥7 对应正价折算约 70 币入帐，原因写进
-- mapay_credit.detail。运行时首用会 CREATE TABLE IF NOT EXISTS 同一 DDL，本文件为留档。

CREATE TABLE IF NOT EXISTS first_charge_claim (
  user_id      bigint PRIMARY KEY,
  out_trade_no text NOT NULL UNIQUE,
  coins        bigint NOT NULL CHECK (coins > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
