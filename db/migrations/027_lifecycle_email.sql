-- 027: 生命周期邮件（Resend）——发送幂等记录＋营销退订偏好。
-- 执行时首用会 CREATE TABLE IF NOT EXISTS 同一 DDL（src/lib/lifecycle-email.ts），本档为留档与手工建表用。

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
