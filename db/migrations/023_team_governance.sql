-- 团队治理六面（席位／角色／建画布权限／加入审批／生命周期／用量）的映射层扩充。
--
-- 定性：**在既有团队真源上长**，不新建第二套团队模型。
--   团队真源 = team_user_id（= 团队主 B key 的 biz_api_key.user_id，即 new-api users.id）
--   成员真源 = team_member_quota（019，成员 = new-api 另一个 user）
--   配额真源 = new-api users.quota（本档一律不存任何点数数字——禁影子帐本）
--
-- 本档只存「归属、身份与意图」：
--   role            = 成员在团队中的角色（owner/admin/member）
--   member_create_canvas = 团队级意图（成员能否建共享画布）
--   seats           = 团队可容纳人数（意图上限；上限闸在 team-governance.ts）
--   dissolve_*      = 解散意图与冷静期时间戳
--   status          = 加入申请的四态
-- 以上皆非余额。任何分配／已用／剩余一律即时读 new-api（见 member-quota.ts）。
--
-- 角色模型（与 member-quota 的 user 层模型一致，不另立体系）：
--   ★ 团队主帐（team_user_id）**恒为 owner**，且不入成员名册
--     （019 的 CHECK 已禁止 member_user_id = team_user_id）。
--   ★ 名册列的 role 是「管理角色」；owner 值 = 共同所有者（co-owner，可由主帐指派）。
--   ★ 不变量：owner 集合 = {team_user_id} ∪ 名册 role='owner' ≠ ∅ 恒成立；
--     因此「移除/降级团队主帐」被 team-governance 以 409 last_owner 拒（最后一个 owner）。
--
-- 席位语义（与 max_members 的关系）：
--   min_members(2) ≤ 现有成员数 ≤ seats ≤ max_members(200，硬上限)
--   seats 是「可容纳人数」，满员时加入申请不得自动通过；调整不得低于现有成员数。

-- ── 角色：在 019 既有名册上加栏（不改既有栏位与唯一性语义） ──────────────
ALTER TABLE team_member_quota
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member';

ALTER TABLE team_member_quota
  DROP CONSTRAINT IF EXISTS team_member_quota_role_check;
ALTER TABLE team_member_quota
  ADD CONSTRAINT team_member_quota_role_check CHECK (role IN ('owner', 'admin', 'member'));

-- ── 团队级设定（意图层，与点数无关） ─────────────────────────────────────
-- 主键 = team_user_id：没有团队注册表，团队身份就是主帐 user（不新建平行体系）。
CREATE TABLE IF NOT EXISTS team_settings (
  team_user_id integer PRIMARY KEY,
  -- 成员能否建立「共享画布」。false = 只有 owner/admin 可建（竞品 settings/member-create-canvas）。
  member_create_canvas boolean NOT NULL DEFAULT false,
  -- 席位数（可容纳成员数）。默认 10；运行时以 teamCapacity() 的配置值写入新列，
  -- 此处 DDL 默认只是兜底（与竞品 default_max_members=10 对齐）。
  seats integer NOT NULL DEFAULT 10,
  -- 解散冷静期：排程时刻（NULL = 未排程）。
  dissolve_scheduled_at timestamptz,
  -- 已解散时刻（NULL = 未解散）。执行后名册成员一并停用（意图层，不动任何点数）。
  dissolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT team_settings_seats_within_bounds CHECK (seats >= 1 AND seats <= 100000)
);

-- ── 加入申请四态（pending/approved/rejected/ignored） ────────────────────
CREATE TABLE IF NOT EXISTS team_join_request (
  id text PRIMARY KEY,
  team_user_id integer NOT NULL,
  -- 申请人 new-api user（= 申请所用 biz key 的 user_id）。
  applicant_user_id integer NOT NULL,
  -- 申请所用 biz key：批准时直接作为名册的 member_key_id（归属手柄，非身份）。
  applicant_member_key_id text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by_user_id integer,
  -- 一个申请人对一个团队只保留一条申请（重放天然幂等，不产生第二条）。
  CONSTRAINT team_join_request_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'ignored')),
  CONSTRAINT team_join_request_one_per_applicant UNIQUE (team_user_id, applicant_user_id),
  -- 申请人不能申请自己的团队（主帐恒为 owner，不是成员）。
  CONSTRAINT team_join_request_not_master CHECK (applicant_user_id <> team_user_id)
);

-- 审批台按团队查待审名单。
CREATE INDEX IF NOT EXISTS team_join_request_team_status_idx
  ON team_join_request (team_user_id, status);

-- 名册角色查询（owner 计数、管理面列表）。
CREATE INDEX IF NOT EXISTS team_member_quota_role_idx
  ON team_member_quota (team_user_id, role);
