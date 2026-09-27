-- 029_api_rejection.sql
-- B 端 /v1/* 拒絕遙測：被拒（鑑權／餘額／參數）的請求不進 generation_job，這裡補一條足跡。
-- 只記 key 前 8 位，不記 prompt、不記完整 key、不記 email；寫入失敗不得影響請求本身。
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

-- 按人／按時間查流失：報告與後續漏斗卡都走這兩條。
CREATE INDEX IF NOT EXISTS api_rejection_created_idx ON api_rejection (created_at);
CREATE INDEX IF NOT EXISTS api_rejection_user_idx ON api_rejection (user_id, created_at);