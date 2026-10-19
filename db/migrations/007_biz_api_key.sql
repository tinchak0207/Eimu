-- B 端密钥的权威存储。
--
-- 排障记录（2026-08-05）：密钥原先只存 Vercel Blob，认证读 Blob + env 兜底。
-- Blob store 被 block（"Your store is blocked"）时：
--   - 认证只剩 BIZ_API_KEY_HASHES，新签发的 key 全部 401
--   - 签发写 Blob 失败，admin 与认证两侧数据源永久分叉
--   - 只能手动往容器 env 塞 hash + 重启应急
--
-- Postgres 与 control plane 同机同网，是 /v1 认证路径上最短、最不可能同时
-- 挂掉的依赖 —— 它挂了整个 durable 管线本来就停了，不构成新的单点。
-- Blob 降级为镜像（见 biz-api-key-store.ts），env 保留为最后兜底。

CREATE TABLE IF NOT EXISTS biz_api_key (
  id text PRIMARY KEY,
  label text NOT NULL,
  -- sha256 十六进制小写。唯一约束防止同一把 key 被签发两次。
  key_hash text NOT NULL UNIQUE,
  key_preview text NOT NULL,
  -- New API 的计费用户 id。0 表示无从计费（仅应急 env 通道会出现）。
  user_id integer NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  rpm integer NOT NULL DEFAULT 60,
  -- 空数组 = 不限模型。
  allowed_models text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  total_requests bigint NOT NULL DEFAULT 0,
  total_images bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 认证是每个 B 端请求的第一跳，按 hash 查必须走索引。
CREATE INDEX IF NOT EXISTS biz_api_key_hash_enabled_idx
  ON biz_api_key (key_hash) WHERE enabled;
