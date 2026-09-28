-- 團隊／成員配額（Dramagic 對照面）：**速率／上界限制**的意圖欄位擴充。
--
-- 定性：在既有團隊真源上長，不新建平行表、**不新建任何帳本**。
--   團隊真源 = team_settings（023，主鍵 team_user_id）
--   成員真源 = team_member_quota（019/023，成員 = new-api 另一個 user）
--   配額真源 = new-api users.quota（本檔一律不存任何餘額——禁影子帳本）
--
-- 為什麼「只加欄位」就夠：
--   Dramagic 逐字：「this only limits the maximum points consumption」——每日額度是
--   **速率限制，不是預扣**。因此本檔只存「上限」與「當日已用計數」（觀察值），
--   不存餘額、不做預扣；真實扣費仍走既有五態帳本（billing-ledger / account-ledger）。
--
-- 三種上限（與 Dramagic Team 頁逐字對照）：
--   團隊層 quota_mode：none = no points limit（預設，消耗主帳號可分配餘額）
--                     fixed = allocated fixed team points
--   成員層 quota_mode：unlimited（預設）／fixed（固定點數分配）／daily（每日額度）
--   daily 於 **UTC+8 00:00** 重置且**不累積**（讀取時比對日界，跨日即歸零）。
--
-- 「不累積」的實作口徑：daily_quota_day 記盤上是哪一個配額日（YYYY-MM-DD，UTC+8）；
--   讀取時若 ≠ 當日 ⇒ daily_quota_used 視為 0（team-quota-limits.effectiveDailyUsed）。
--   不清盤、不做排程任務，跨日純由讀取端判定 ⇒ 無需 cron、無競態。
--
-- 紅線：本檔**不建立任何 ledgers / balances / wallets 表**，也不參照任何帳本表。
--   team_member_quota / team_settings 只承載「身份、意圖、上限、速率計數」。

-- ── 團隊層：配額模式與固定額度上限（意圖欄位，非餘額） ──────────────────
ALTER TABLE team_settings
  ADD COLUMN IF NOT EXISTS quota_mode text NOT NULL DEFAULT 'none';

ALTER TABLE team_settings
  ADD COLUMN IF NOT EXISTS fixed_quota bigint NOT NULL DEFAULT 0;

ALTER TABLE team_settings
  DROP CONSTRAINT IF EXISTS team_settings_quota_mode_check;
ALTER TABLE team_settings
  ADD CONSTRAINT team_settings_quota_mode_check CHECK (quota_mode IN ('none', 'fixed'));

ALTER TABLE team_settings
  DROP CONSTRAINT IF EXISTS team_settings_fixed_quota_nonneg_check;
ALTER TABLE team_settings
  ADD CONSTRAINT team_settings_fixed_quota_nonneg_check CHECK (fixed_quota >= 0);

-- ── 成員層：配額模式、固定額度、每日額度與當日已用計數 ──────────────────
ALTER TABLE team_member_quota
  ADD COLUMN IF NOT EXISTS quota_mode text NOT NULL DEFAULT 'unlimited';

ALTER TABLE team_member_quota
  ADD COLUMN IF NOT EXISTS member_fixed_quota bigint NOT NULL DEFAULT 0;

ALTER TABLE team_member_quota
  ADD COLUMN IF NOT EXISTS daily_quota bigint NOT NULL DEFAULT 0;

-- 記盤上是哪一個配額日（YYYY-MM-DD，UTC+8 日界）。NULL = 尚未使用過。
ALTER TABLE team_member_quota
  ADD COLUMN IF NOT EXISTS daily_quota_day text;

-- 當日已用計數 = **速率觀察值**（不參與任何餘額計算、不是預扣）。
ALTER TABLE team_member_quota
  ADD COLUMN IF NOT EXISTS daily_quota_used bigint NOT NULL DEFAULT 0;

ALTER TABLE team_member_quota
  DROP CONSTRAINT IF EXISTS team_member_quota_quota_mode_check;
ALTER TABLE team_member_quota
  ADD CONSTRAINT team_member_quota_quota_mode_check
  CHECK (quota_mode IN ('unlimited', 'fixed', 'daily'));

ALTER TABLE team_member_quota
  DROP CONSTRAINT IF EXISTS team_member_quota_amounts_nonneg_check;
ALTER TABLE team_member_quota
  ADD CONSTRAINT team_member_quota_amounts_nonneg_check
  CHECK (member_fixed_quota >= 0 AND daily_quota >= 0 AND daily_quota_used >= 0);

-- 成員層配額為意圖欄位；查詢熱路徑仍按 member_user_id（019 的 UNIQUE 索引）。
