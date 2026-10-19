-- 029_api_rejection.sql
-- B 端 /v1/* 拒绝遥测：被拒（鉴权／余额／参数）的请求不进 generation_job，这里补一条足迹。
-- 只记 key 前 8 位，不记 prompt、不记完整 key、不记 email；写入失败不得影响请求本身。
CREATE TABLE IF NOT EXISTS api_rejection (
  id         bigserial PRIMARY KEY,
  user_id    bigint,
  key_prefix text,
  path       text NOT NULL,
  model      text,
  status     int NOT NULL,
  reason     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 按人／按时间查流失：报告与后续漏斗卡都走这两条。
CREATE INDEX IF NOT EXISTS api_rejection_created_idx ON api_rejection (created_at);
CREATE INDEX IF NOT EXISTS api_rejection_user_idx ON api_rejection (user_id, created_at);