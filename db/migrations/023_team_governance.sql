-- 團隊治理六面（席位／角色／建畫布權限／加入審批／生命週期／用量）的映射層擴充。
--
-- 定性：**在既有團隊真源上長**，不新建第二套團隊模型。
--   團隊真源 = team_user_id（= 團隊主 B key 的 biz_api_key.user_id，即 new-api users.id）
--   成員真源 = team_member_quota（019，成員 = new-api 另一個 user）
--   配額真源 = new-api users.quota（本檔一律不存任何點數數字——禁影子帳本）
--
-- 本檔只存「歸屬、身份與意圖」：
--   role            = 成員在團隊中的角色（owner/admin/member）
--   member_create_canvas = 團隊級意圖（成員能否建共享畫布）
--   seats           = 團隊可容納人數（意圖上限；上限閘在 team-governance.ts）
--   dissolve_*      = 解散意圖與冷靜期時間戳
--   status          = 加入申請的四態
-- 以上皆非餘額。任何分配／已用／剩餘一律即時讀 new-api（見 member-quota.ts）。
--
-- 角色模型（與 member-quota 的 user 層模型一致，不另立體系）：
--   ★ 團隊主帳（team_user_id）**恆為 owner**，且不入成員名冊
--     （019 的 CHECK 已禁止 member_user_id = team_user_id）。
--   ★ 名冊列的 role 是「管理角色」；owner 值 = 共同所有者（co-owner，可由主帳指派）。
--   ★ 不變量：owner 集合 = {team_user_id} ∪ 名冊 role='owner' ≠ ∅ 恆成立；
--     因此「移除/降級團隊主帳」被 team-governance 以 409 last_owner 拒（最後一個 owner）。
--
-- 席位語義（與 max_members 的關係）：
--   min_members(2) ≤ 現有成員數 ≤ seats ≤ max_members(200，硬上限)
--   seats 是「可容納人數」，滿員時加入申請不得自動通過；調整不得低於現有成員數。

-- ── 角色：在 019 既有名冊上加欄（不改既有欄位與唯一性語義） ──────────────
ALTER TABLE team_member_quota
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member';

ALTER TABLE team_member_quota
  DROP CONSTRAINT IF EXISTS team_member_quota_role_check;
ALTER TABLE team_member_quota
  ADD CONSTRAINT team_member_quota_role_check CHECK (role IN ('owner', 'admin', 'member'));

-- ── 團隊級設定（意圖層，與點數無關） ─────────────────────────────────────
-- 主鍵 = team_user_id：沒有團隊註冊表，團隊身份就是主帳 user（不新建平行體系）。
CREATE TABLE IF NOT EXISTS team_settings (
  team_user_id integer PRIMARY KEY,
  -- 成員能否建立「共享畫布」。false = 只有 owner/admin 可建（競品 settings/member-create-canvas）。
  member_create_canvas boolean NOT NULL DEFAULT false,
  -- 席位數（可容納成員數）。默認 10；運行時以 teamCapacity() 的配置值寫入新列，
  -- 此處 DDL 默認只是兜底（與競品 default_max_members=10 對齊）。
  seats integer NOT NULL DEFAULT 10,
  -- 解散冷靜期：排程時刻（NULL = 未排程）。
  dissolve_scheduled_at timestamptz,
  -- 已解散時刻（NULL = 未解散）。執行後名冊成員一併停用（意圖層，不動任何點數）。
  dissolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT team_settings_seats_within_bounds CHECK (seats >= 1 AND seats <= 100000)
);

-- ── 加入申請四態（pending/approved/rejected/ignored） ────────────────────
CREATE TABLE IF NOT EXISTS team_join_request (
  id text PRIMARY KEY,
  team_user_id integer NOT NULL,
  -- 申請人 new-api user（= 申請所用 biz key 的 user_id）。
  applicant_user_id integer NOT NULL,
  -- 申請所用 biz key：批准時直接作為名冊的 member_key_id（歸屬手柄，非身份）。
  applicant_member_key_id text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by_user_id integer,
  -- 一個申請人對一個團隊只保留一條申請（重放天然幂等，不產生第二條）。
  CONSTRAINT team_join_request_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'ignored')),
  CONSTRAINT team_join_request_one_per_applicant UNIQUE (team_user_id, applicant_user_id),
  -- 申請人不能申請自己的團隊（主帳恆為 owner，不是成員）。
  CONSTRAINT team_join_request_not_master CHECK (applicant_user_id <> team_user_id)
);

-- 審批台按團隊查待審名單。
CREATE INDEX IF NOT EXISTS team_join_request_team_status_idx
  ON team_join_request (team_user_id, status);

-- 名冊角色查詢（owner 計數、管理面列表）。
CREATE INDEX IF NOT EXISTS team_member_quota_role_idx
  ON team_member_quota (team_user_id, role);
