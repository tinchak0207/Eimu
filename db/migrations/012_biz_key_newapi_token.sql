-- biz key ↔ new-api token 映射（中控外科手術 P1 第 3 刀）。
--
-- 手術計畫（CONTROL-PLANE-SURGERY.md P1）：自研 reserve 阻塞閘拆除後，配額執法
-- 歸 new-api 內核。每把 biz key 對應一把 new-api token：
--   - 提交前配額原子預檢按 token_id 查 new-api 剩餘額度（無狀態、無執行器）
--   - 事後記帳從 new-api 消費日誌按 token 維度異步投影（另一域負責）
--
-- biz_api_key.user_id 是 new-api 的「用戶」維度映射（舊有）；本表補「token」維度。
-- new-api relay 請求以 token（sk-...）鑑權，配額預檢與消費日誌都掛在 token 上。
--
-- 手術切換前必須為現存 biz key 補齊映射；預檢在映射缺失時 fail-closed（不放行），
-- 不會靜默把無配額執法的訂單放進內核。

CREATE TABLE IF NOT EXISTS biz_key_newapi_token (
  -- biz_api_key.id。key 被 revoke 刪除時映射級聯消失，不留懸掛引用。
  biz_key_id text PRIMARY KEY REFERENCES biz_api_key(id) ON DELETE CASCADE,
  -- new-api tokens.id（整數主鍵）。
  token_id integer NOT NULL UNIQUE,
  -- `sk-xxxx…` 截斷展示片段，僅供排障對照；不存明文 token 值。
  token_key_preview text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 反查索引由 token_id 的 UNIQUE 約束自帶（Postgres 為 UNIQUE 建唯一索引），
-- 事後記帳投影按 token 維度反查（new-api 消費日誌 → biz key）直接命中，不另建重複索引。
