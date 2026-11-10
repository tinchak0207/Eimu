-- 补录此前只存在于运行时代码（CREATE TABLE IF NOT EXISTS）、db/migrations 里没有的 Postgres 表。
-- expand-only：全部 IF NOT EXISTS，在表已存在的生产库上是空操作；不 ALTER 任何已有列。
-- 运行时仍保留自建逻辑，本迁移只为新库引导与文档化；二者必须保持一致（改一边必须同步另一边）。
-- 执行器 tools/apply-migrations.ts 已自带 BEGIN/COMMIT，本文件不写事务语句。
--
-- 表 | 来源档案:行号（DDL 逐字取自该处）
--   newapi_session_token         src/lib/newapi-session-token.ts:80
--   newapi_session_revocation    src/lib/newapi-session-token.ts:100
--   agent_user_profiles          src/lib/agent-profile-store.ts:170
--   agent_lessons (+索引)        src/lib/agent-profile-store.ts:182,190
--   agent_user_keys              src/lib/agent-user-key.ts:114
--   emu_oauth_consumed           src/lib/emu-oauth.ts:107
--   mapay_redemption_claim       src/lib/mapay-redemption.ts:164（仅 mapay_order_intake 不可用时的降级占位表）
--   music_charge                 src/lib/music-charge.ts:253
--   sync_idempotency_cache       src/lib/generation-core/sync-idempotency.ts:57
--
-- 未收录（不是 Postgres 表）：tool_submission / tool_rate / tool_artifact / tool_project 是
-- src/vendor-bridges/lib/image-journal.ts:21-33（及 deploy-staging/opencode-runtime/lib/image-journal.ts）
-- 的 bun:sqlite 本地日志库（REAL/INTEGER、AUTOINCREMENT 式 SQLite 语义、PRAGMA table_info 补列），
-- 不在 Postgres 里，放进迁移只会造出永远没人读写的死表。
--
-- 已核对：同一张表在运行时代码里只有一处 DDL，无列分歧；上述各表在运行时没有后续
-- ALTER TABLE ... ADD COLUMN（grep 全 src/tools/bridge/deploy-staging 确认）。

-- newapi_session_token
CREATE TABLE IF NOT EXISTS newapi_session_token (
  user_id    INTEGER PRIMARY KEY,
  token      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- newapi_session_revocation
CREATE TABLE IF NOT EXISTS newapi_session_revocation (
  token_hash TEXT PRIMARY KEY,
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- agent_user_profiles
CREATE TABLE IF NOT EXISTS agent_user_profiles (
  user_id       BIGINT PRIMARY KEY,
  industry      TEXT,
  asset_types   JSONB NOT NULL DEFAULT '[]'::jsonb,
  typical_specs JSONB NOT NULL DEFAULT '[]'::jsonb,
  style_preferences JSONB NOT NULL DEFAULT '[]'::jsonb,
  prohibitions  JSONB NOT NULL DEFAULT '[]'::jsonb,
  habits        JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes         TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  updated_at    TIMESTAMPTZ NOT NULL
);

-- agent_lessons
CREATE TABLE IF NOT EXISTS agent_lessons (
  id               TEXT PRIMARY KEY,
  user_id          BIGINT NOT NULL,
  summary          TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  confirmed        BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_lessons_user ON agent_lessons (user_id, confirmed);

-- agent_user_keys
CREATE TABLE IF NOT EXISTS agent_user_keys (
  user_id bigint PRIMARY KEY,
  biz_key_id text NOT NULL,
  encrypted_key text NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- emu_oauth_consumed
CREATE TABLE IF NOT EXISTS emu_oauth_consumed (
  code_hash text PRIMARY KEY,
  consumed_at timestamptz NOT NULL DEFAULT now()
);

-- mapay_redemption_claim
CREATE TABLE IF NOT EXISTS mapay_redemption_claim (
  out_trade_no text PRIMARY KEY,
  state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- music_charge
CREATE TABLE IF NOT EXISTS music_charge (
  charge_ref      text PRIMARY KEY,
  billing_user_id bigint NOT NULL,
  amount_quota    bigint NOT NULL CHECK (amount_quota > 0),
  status          text NOT NULL CHECK (status IN ('pending', 'applied', 'failed', 'unknown')),
  detail          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- sync_idempotency_cache
CREATE TABLE IF NOT EXISTS sync_idempotency_cache (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  idem_key    TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code  INT,
  response_json TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idem_key)
);
