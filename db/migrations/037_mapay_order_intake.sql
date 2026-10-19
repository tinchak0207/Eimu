-- 037: mapay_order_intake —— mPay 回调落地存证表（src/lib/mapay-intake.ts）。
--
-- 为什么需要它：2026-09-19 真实订单 IMGMU7UH9SFF9A21D（9.90/实付 9.93）被支付商
-- GET 推送 6 次、我方全回 body fail + HTTP 500（耗时 1.6–3.2s＝进了网络才失败）。
-- 旧流程在 fulfillMapayRedemption 之前**不写任何落地记录**，履约一炸（当时打到一条
-- 已死的 gateway 默认 URL）这笔订单在我方数据库零痕迹，只能靠支付商后台才发现。
-- 本表在验签通过、支付成功后、**任何履约副作用之前**落一条存证：即使履约链整条炸掉，
-- 订单也不再消失；notify 履约成功后标 fulfilled，失败由 cron sweep 幂等重投。
--
-- 不是帐本：金额的权威记录仍是 account_ledger 的 recharge 行。本表只有状态机：
--   received  已落地、尚未确认交付（cron sweep 会挑 10 分钟以上的行重投）
--   fulfilled 已交付（delivery 记通道：direct_credit 直达入帐 / redemption_code 兑换码）
--   parked    反复失败超过 6 次，停止自动重试、留人工核对
--
-- sweep_attempts：cron 重投失败计数；达到阈值即 parked（上游调额不幂等，宁可停不可双发）。
-- 运行时首用会 CREATE TABLE IF NOT EXISTS 同一 DDL，本文件为留档与手工建表用（同 030 惯例）。

CREATE TABLE IF NOT EXISTS mapay_order_intake (
  out_trade_no   text PRIMARY KEY,
  raw_params     jsonb NOT NULL,
  money          text,
  plan_id        text,
  param          text,
  user_id        bigint,
  state          text NOT NULL CHECK (state IN ('received', 'fulfilled', 'parked')),
  delivery       text CHECK (delivery IN ('direct_credit', 'redemption_code')),
  detail         text,
  sweep_attempts integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mapay_order_intake_state_created_idx
  ON mapay_order_intake (state, created_at);