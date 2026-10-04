-- 团队／成员配额（Dramagic 对照面）：**速率／上界限制**的意图栏位扩充。
--
-- 定性：在既有团队真源上长，不新建平行表、**不新建任何帐本**。
--   团队真源 = team_settings（023，主键 team_user_id）
--   成员真源 = team_member_quota（019/023，成员 = new-api 另一个 user）
--   配额真源 = new-api users.quota（本档一律不存任何余额——禁影子帐本）
--
-- 为什么「只加栏位」就够：
--   Dramagic 逐字：「this only limits the maximum points consumption」——每日额度是
--   **速率限制，不是预扣**。因此本档只存「上限」与「当日已用计数」（观察值），
--   不存余额、不做预扣；真实扣费仍走既有五态帐本（billing-ledger / account-ledger）。
--
-- 三种上限（与 Dramagic Team 页逐字对照）：
--   团队层 quota_mode：none = no points limit（预设，消耗主帐号可分配余额）
--                     fixed = allocated fixed team points
--   成员层 quota_mode：unlimited（预设）／fixed（固定点数分配）／daily（每日额度）
--   daily 于 **UTC+8 00:00** 重置且**不累积**（读取时比对日界，跨日即归零）。
--
-- 「不累积」的实作口径：daily_quota_day 记盘上是哪一个配额日（YYYY-MM-DD，UTC+8）；
--   读取时若 ≠ 当日 ⇒ daily_quota_used 视为 0（team-quota-limits.effectiveDailyUsed）。
--   不清盘、不做排程任务，跨日纯由读取端判定 ⇒ 无需 cron、无竞态。
--
-- 红线：本档**不建立任何 ledgers / balances / wallets 表**，也不参照任何帐本表。
--   team_member_quota / team_settings 只承载「身份、意图、上限、速率计数」。

-- ── 团队层：配额模式与固定额度上限（意图栏位，非余额） ──────────────────
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

-- ── 成员层：配额模式、固定额度、每日额度与当日已用计数 ──────────────────
ALTER TABLE team_member_quota
  ADD COLUMN IF NOT EXISTS quota_mode text NOT NULL DEFAULT 'unlimited';

ALTER TABLE team_member_quota
  ADD COLUMN IF NOT EXISTS member_fixed_quota bigint NOT NULL DEFAULT 0;

ALTER TABLE team_member_quota
  ADD COLUMN IF NOT EXISTS daily_quota bigint NOT NULL DEFAULT 0;

-- 记盘上是哪一个配额日（YYYY-MM-DD，UTC+8 日界）。NULL = 尚未使用过。
ALTER TABLE team_member_quota
  ADD COLUMN IF NOT EXISTS daily_quota_day text;

-- 当日已用计数 = **速率观察值**（不参与任何余额计算、不是预扣）。
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

-- 成员层配额为意图栏位；查询热路径仍按 member_user_id（019 的 UNIQUE 索引）。
