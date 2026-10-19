CREATE TABLE IF NOT EXISTS admin_config_change (
  id text PRIMARY KEY,
  config_key text NOT NULL,           -- e.g. 'channel-overrides', 'admin-pools'
  version integer NOT NULL,
  actor text,                          -- admin identity if available, else 'unknown'
  action text NOT NULL CHECK (action IN ('update', 'rollback')),
  previous_version integer,
  diff_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  full_snapshot_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_config_change_key_idx ON admin_config_change (config_key, version DESC);
