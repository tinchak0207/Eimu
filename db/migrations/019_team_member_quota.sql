-- B1 成员点数配额（REQ-B1）：团队-成员-配额「映射层」（user 层模型）。
--
-- 铁律（见记忆 control-plane-billing-paradigm）：new-api 是配额唯一权威源，
-- 本表不存任何点数数字——影子帐本禁止。归属（哪个成员 user 属于哪个团队主帐）
-- 在此，而分配／已用／剩余一律即时读 new-api 权威源：
--   主帐剩余 = new-api users.quota（团队主帐 user）
--   成员上限 = 成员 user 的 (users.quota + users.used_quota)
--   成员已用 = 成员 user 的 users.used_quota（该帐号累计消耗）
--   成员剩余 = 成员 user 的 users.quota（真正的桶）
-- enabled/label 是身份与意图，不是余额；改 new-api 的 user 额度才是分配动作。
--
-- 成员主体 = new-api **另一个 user**（子帐号）：配额桶就是该 user 自己的
-- users.quota，内核对它一律执法（unlimited_quota 只是 token 层属性，user 层
-- 没有这个概念）。因此「成员扣费」由内核直接扣成员 user 的 quota；「主帐扣减」
-- 发生在分配那一刻——主帐 user 的 quota 扣掉多少，成员 user 就加上多少
-- （member-quota.ts 的 transferQuota：先扣后加，两条腿不成功即回滚），
-- 全团队总额守恒（主帐 + Σ成员桶 + Σ已用 = 常数），不会凭空印额度。
--
-- 不变量（由 member-quota.ts 的分配路径强制）：
--   ★ 成员 user_id 必须**不等于** team_user_id —— 成员是另一个 user，不是主帐
--     自己；同一个 user 的多把 biz key 共用同一桶（归属按 member_user_id 唯一，
--     不按 key 唯一）。成员 user 同时只能归属于一个团队主帐（跨团队 403）。
--   ★ 本次划出的差额不得超过主帐手上余额（先扣后加 ⇒ 不可能超卖）。
--
-- 旧版（token 子额度桶模型）已被 09-23 只读探针硬否定：admin 凭证 owner-scoped，
-- GET /api/token/{id} 对他人 token 回 200 + success:false「record not found」，
-- 且生产 biz token 全 unlimited_quota=1（桶在内核根本不扣）。故 member_token_id
-- 改为 member_user_id。本表尚未 apply（生产无此表）⇒ 零迁移成本。

CREATE TABLE IF NOT EXISTS team_member_quota (
  id text PRIMARY KEY,
  -- 团队主帐（出资方）：new-api users.id。= 团队主 B key 的 biz_api_key.user_id。
  team_user_id integer NOT NULL,
  -- 成员 new-api user（配额桶所在）。一个 user 只能有一条成员归属。
  member_user_id integer NOT NULL UNIQUE,
  -- 登记时使用的成员 biz key（biz_api_key.id）：展示／寻址手柄，非身份。
  -- 同一 user 的多把 key 共用 member_user_id 这一桶，故此栏不参与唯一性判决；
  -- key 被撤销时这条归属记录一起消失（不留悬挂引用）。
  member_key_id text NOT NULL UNIQUE REFERENCES biz_api_key(id) ON DELETE CASCADE,
  -- 展示名，来自成员 key 的 label（可覆写）。非余额栏位。
  display_name text NOT NULL DEFAULT '',
  -- 停用 = 该成员的单一律拒（预检按成员额度不足/停用文案拒单），不删归属记录以便回滚。
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 主帐不能把自己登记成成员（配额桶会指向同一帐号）。
  CONSTRAINT team_member_quota_member_not_master CHECK (member_user_id <> team_user_id)
);

-- 可视面按团队主帐列成员；预检热路径按 member_user_id 查（UNIQUE 自带索引）。
CREATE INDEX IF NOT EXISTS team_member_quota_team_idx
  ON team_member_quota (team_user_id);
