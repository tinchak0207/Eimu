-- biz key ↔ new-api token 映射（中控外科手术 P1 第 3 刀）。
--
-- 手术计画（CONTROL-PLANE-SURGERY.md P1）：自研 reserve 阻塞闸拆除后，配额执法
-- 归 new-api 内核。每把 biz key 对应一把 new-api token：
--   - 提交前配额原子预检按 token_id 查 new-api 剩余额度（无状态、无执行器）
--   - 事后记帐从 new-api 消费日志按 token 维度异步投影（另一域负责）
--
-- biz_api_key.user_id 是 new-api 的「用户」维度映射（旧有）；本表补「token」维度。
-- new-api relay 请求以 token（sk-...）鉴权，配额预检与消费日志都挂在 token 上。
--
-- 手术切换前必须为现存 biz key 补齐映射；预检在映射缺失时 fail-closed（不放行），
-- 不会静默把无配额执法的订单放进内核。

CREATE TABLE IF NOT EXISTS biz_key_newapi_token (
  -- biz_api_key.id。key 被 revoke 删除时映射级联消失，不留悬挂引用。
  biz_key_id text PRIMARY KEY REFERENCES biz_api_key(id) ON DELETE CASCADE,
  -- new-api tokens.id（整数主键）。
  token_id integer NOT NULL UNIQUE,
  -- `sk-xxxx…` 截断展示片段，仅供排障对照；不存明文 token 值。
  token_key_preview text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 反查索引由 token_id 的 UNIQUE 约束自带（Postgres 为 UNIQUE 建唯一索引），
-- 事后记帐投影按 token 维度反查（new-api 消费日志 → biz key）直接命中，不另建重复索引。
