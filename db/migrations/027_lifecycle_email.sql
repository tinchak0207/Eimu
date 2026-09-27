-- 027: 生命週期郵件（Resend）——發送冪等記錄＋營銷退訂偏好。
-- 執行時首用會 CREATE TABLE IF NOT EXISTS 同一 DDL（src/lib/lifecycle-email.ts），本檔為留檔與手工建表用。

CREATE TABLE IF NOT EXISTS email_send_log (
  user_id    bigint NOT NULL,
  template   text NOT NULL,
  status     text NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz,
  PRIMARY KEY (user_id, template)
);

CREATE TABLE IF NOT EXISTS email_preference (
  user_id            bigint PRIMARY KEY,
  marketing_opt_out  boolean NOT NULL DEFAULT false,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
