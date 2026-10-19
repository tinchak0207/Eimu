CREATE TABLE IF NOT EXISTS lora_user_state (
  user_id bigint NOT NULL,
  model_version_id text NOT NULL,
  title text NOT NULL,
  thumb_url text NOT NULL,
  favorite boolean NOT NULL DEFAULT false,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, model_version_id),
  CHECK (char_length(model_version_id) BETWEEN 1 AND 200),
  CHECK (char_length(title) BETWEEN 1 AND 300),
  CHECK (char_length(thumb_url) BETWEEN 1 AND 2000)
);

CREATE INDEX IF NOT EXISTS lora_user_state_favorites_idx
  ON lora_user_state (user_id, updated_at DESC)
  WHERE favorite;

CREATE INDEX IF NOT EXISTS lora_user_state_recent_idx
  ON lora_user_state (user_id, last_used_at DESC)
  WHERE last_used_at IS NOT NULL;
