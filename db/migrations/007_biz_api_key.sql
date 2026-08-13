-- B 端密鑰的權威存儲。
--
-- 排障記錄（2026-08-05）：密鑰原先只存 Vercel Blob，認證讀 Blob + env 兜底。
-- Blob store 被 block（"Your store is blocked"）時：
--   - 認證只剩 BIZ_API_KEY_HASHES，新簽發的 key 全部 401
--   - 簽發寫 Blob 失敗，admin 與認證兩側數據源永久分叉
--   - 只能手動往容器 env 塞 hash + 重啟應急
--
-- Postgres 與 control plane 同機同網，是 /v1 認證路徑上最短、最不可能同時
-- 掛掉的依賴 —— 它掛了整個 durable 管線本來就停了，不構成新的單點。
-- Blob 降級為鏡像（見 biz-api-key-store.ts），env 保留為最後兜底。

CREATE TABLE IF NOT EXISTS biz_api_key (
  id text PRIMARY KEY,
  label text NOT NULL,
  -- sha256 十六進制小寫。唯一約束防止同一把 key 被簽發兩次。
  key_hash text NOT NULL UNIQUE,
  key_preview text NOT NULL,
  -- New API 的計費用戶 id。0 表示無從計費（僅應急 env 通道會出現）。
  user_id integer NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  rpm integer NOT NULL DEFAULT 60,
  -- 空數組 = 不限模型。
  allowed_models text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  total_requests bigint NOT NULL DEFAULT 0,
  total_images bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 認證是每個 B 端請求的第一跳，按 hash 查必須走索引。
CREATE INDEX IF NOT EXISTS biz_api_key_hash_enabled_idx
  ON biz_api_key (key_hash) WHERE enabled;
