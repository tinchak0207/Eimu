-- 030: mapay_credit —— mPay 付款直达入帐占位表（src/lib/mapay-credit.ts）。
--
-- 不是帐本：金额的权威记录仍是 account_ledger 的 recharge 行
-- （idempotency_ref = 'redemption:<out_trade_no>'，来源 redemption-sync = 现金营收）。
-- 本表只解决一件事：上游 new-api 调额（/api/user/manage add_quota）本身不幂等，
-- 必须在动上游之前先占位（主键 out_trade_no），保证同一张单永远只加一次额；
-- 占位一旦存在就不再重占（含 failed），重放/重试不会与已退回旧流程生成的兑换码叠成双份。
--
-- 状态机：pending（已占位，不自动重试）→ applied（上游已加额）
--                                      → failed（上游明确没动，可安全退回旧兑换码流程）
--                                      → unknown（上游结果不明，不自动重试，人工核对）
-- 运行时首用会 CREATE TABLE IF NOT EXISTS 同一 DDL，本文件为留档与手工建表用。

CREATE TABLE IF NOT EXISTS mapay_credit (
  out_trade_no text PRIMARY KEY,
  user_id      bigint NOT NULL,
  plan_id      text NOT NULL,
  amount_quota bigint NOT NULL CHECK (amount_quota > 0),
  status       text NOT NULL CHECK (status IN ('pending', 'applied', 'failed', 'unknown')),
  detail       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);