-- B1 成員點數配額（REQ-B1）：團隊-成員-配額「映射層」（user 層模型）。
--
-- 鐵律（見記憶 control-plane-billing-paradigm）：new-api 是配額唯一權威源，
-- 本表不存任何點數數字——影子帳本禁止。歸屬（哪個成員 user 屬於哪個團隊主帳）
-- 在此，而分配／已用／剩餘一律即時讀 new-api 權威源：
--   主帳剩餘 = new-api users.quota（團隊主帳 user）
--   成員上限 = 成員 user 的 (users.quota + users.used_quota)
--   成員已用 = 成員 user 的 users.used_quota（該帳號累計消耗）
--   成員剩餘 = 成員 user 的 users.quota（真正的桶）
-- enabled/label 是身份與意圖，不是餘額；改 new-api 的 user 額度才是分配動作。
--
-- 成員主體 = new-api **另一個 user**（子帳號）：配額桶就是該 user 自己的
-- users.quota，內核對它一律執法（unlimited_quota 只是 token 層屬性，user 層
-- 沒有這個概念）。因此「成員扣費」由內核直接扣成員 user 的 quota；「主帳扣減」
-- 發生在分配那一刻——主帳 user 的 quota 扣掉多少，成員 user 就加上多少
-- （member-quota.ts 的 transferQuota：先扣後加，兩條腿不成功即回滾），
-- 全團隊總額守恆（主帳 + Σ成員桶 + Σ已用 = 常數），不會憑空印額度。
--
-- 不變量（由 member-quota.ts 的分配路徑強制）：
--   ★ 成員 user_id 必須**不等於** team_user_id —— 成員是另一個 user，不是主帳
--     自己；同一個 user 的多把 biz key 共用同一桶（歸屬按 member_user_id 唯一，
--     不按 key 唯一）。成員 user 同時只能歸屬於一個團隊主帳（跨團隊 403）。
--   ★ 本次劃出的差額不得超過主帳手上餘額（先扣後加 ⇒ 不可能超賣）。
--
-- 舊版（token 子額度桶模型）已被 09-23 只讀探針硬否定：admin 憑證 owner-scoped，
-- GET /api/token/{id} 對他人 token 回 200 + success:false「record not found」，
-- 且生產 biz token 全 unlimited_quota=1（桶在內核根本不扣）。故 member_token_id
-- 改為 member_user_id。本表尚未 apply（生產無此表）⇒ 零遷移成本。

CREATE TABLE IF NOT EXISTS team_member_quota (
  id text PRIMARY KEY,
  -- 團隊主帳（出資方）：new-api users.id。= 團隊主 B key 的 biz_api_key.user_id。
  team_user_id integer NOT NULL,
  -- 成員 new-api user（配額桶所在）。一個 user 只能有一條成員歸屬。
  member_user_id integer NOT NULL UNIQUE,
  -- 登記時使用的成員 biz key（biz_api_key.id）：展示／尋址手柄，非身份。
  -- 同一 user 的多把 key 共用 member_user_id 這一桶，故此欄不參與唯一性判決；
  -- key 被撤銷時這條歸屬記錄一起消失（不留懸掛引用）。
  member_key_id text NOT NULL UNIQUE REFERENCES biz_api_key(id) ON DELETE CASCADE,
  -- 展示名，來自成員 key 的 label（可覆寫）。非餘額欄位。
  display_name text NOT NULL DEFAULT '',
  -- 停用 = 該成員的單一律拒（預檢按成員額度不足/停用文案拒單），不刪歸屬記錄以便回滾。
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 主帳不能把自己登記成成員（配額桶會指向同一帳號）。
  CONSTRAINT team_member_quota_member_not_master CHECK (member_user_id <> team_user_id)
);

-- 可視面按團隊主帳列成員；預檢熱路徑按 member_user_id 查（UNIQUE 自帶索引）。
CREATE INDEX IF NOT EXISTS team_member_quota_team_idx
  ON team_member_quota (team_user_id);
