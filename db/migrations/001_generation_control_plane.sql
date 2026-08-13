CREATE TABLE IF NOT EXISTS generation_schema_migration (
  name text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS supplier (
  id text PRIMARY KEY,
  label text NOT NULL,
  adapter_type text NOT NULL CHECK (adapter_type IN ('adobe2api', 'openai_images')),
  supply_tier text NOT NULL DEFAULT 'relay' CHECK (supply_tier IN ('first_party', 'managed_pool', 'relay', 'fallback')),
  failure_domain text NOT NULL,
  base_url text NOT NULL,
  credential_ref text NOT NULL,
  configuration_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 100,
  concurrency_limit integer NOT NULL DEFAULT 1 CHECK (concurrency_limit > 0),
  quality_score double precision NOT NULL DEFAULT 1 CHECK (quality_score >= 0 AND quality_score <= 1),
  unit_cost numeric(18, 6) NOT NULL DEFAULT 0,
  health_status text NOT NULL DEFAULT 'healthy' CHECK (health_status IN ('healthy', 'degraded', 'cooldown', 'disabled')),
  health_score double precision NOT NULL DEFAULT 1 CHECK (health_score >= 0 AND health_score <= 1),
  latency_ewma_ms double precision,
  cooldown_until timestamptz,
  last_selected_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  success_count bigint NOT NULL DEFAULT 0,
  failure_count bigint NOT NULL DEFAULT 0,
  config_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS supplier_account (
  id text PRIMARY KEY,
  supplier_id text NOT NULL REFERENCES supplier(id) ON DELETE CASCADE,
  label text NOT NULL,
  credential_ref text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  concurrency_limit integer NOT NULL DEFAULT 1 CHECK (concurrency_limit > 0),
  health_status text NOT NULL DEFAULT 'healthy' CHECK (health_status IN ('healthy', 'degraded', 'cooldown', 'disabled')),
  cooldown_until timestamptz,
  token_source text,
  credential_expires_at timestamptz,
  refresh_status text NOT NULL DEFAULT 'unknown' CHECK (refresh_status IN ('unknown', 'healthy', 'failing', 'expired')),
  last_refresh_at timestamptz,
  last_refresh_failure_at timestamptz,
  attempts_5m integer NOT NULL DEFAULT 0,
  successes_5m integer NOT NULL DEFAULT 0,
  success_rate_5m double precision NOT NULL DEFAULT 1 CHECK (success_rate_5m >= 0 AND success_rate_5m <= 1),
  health_observed_at timestamptz,
  last_selected_at timestamptz,
  configuration_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, credential_ref)
);
CREATE INDEX IF NOT EXISTS supplier_account_sched_idx
  ON supplier_account (supplier_id, enabled, health_status, cooldown_until);

CREATE TABLE IF NOT EXISTS supplier_capability (
  id bigserial PRIMARY KEY,
  supplier_id text NOT NULL REFERENCES supplier(id) ON DELETE CASCADE,
  contract_version bigint NOT NULL DEFAULT 1,
  is_current boolean NOT NULL DEFAULT true,
  public_model_id text NOT NULL,
  supplier_model_id text,
  kind text NOT NULL CHECK (kind IN ('image_generate', 'image_edit', 'video_generate')),
  ratios text[] NOT NULL DEFAULT '{}',
  resolutions text[] NOT NULL DEFAULT '{}',
  edit_support boolean NOT NULL DEFAULT false,
  video_support boolean NOT NULL DEFAULT false,
  concurrency_limit integer NOT NULL DEFAULT 1 CHECK (concurrency_limit > 0),
  health_status text NOT NULL DEFAULT 'healthy' CHECK (health_status IN ('healthy', 'degraded', 'cooldown', 'disabled')),
  health_score double precision NOT NULL DEFAULT 1 CHECK (health_score >= 0 AND health_score <= 1),
  cooldown_until timestamptz,
  success_count bigint NOT NULL DEFAULT 0,
  failure_count bigint NOT NULL DEFAULT 0,
  cost_units numeric(18, 6) NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, public_model_id, kind, contract_version)
);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_capability_current_uq
  ON supplier_capability (supplier_id, public_model_id, kind)
  WHERE is_current;

CREATE TABLE IF NOT EXISTS supplier_health_event (
  id bigserial PRIMARY KEY,
  supplier_id text NOT NULL REFERENCES supplier(id) ON DELETE CASCADE,
  supplier_account_id text NOT NULL REFERENCES supplier_account(id) ON DELETE CASCADE,
  supplier_capability_id bigint NOT NULL REFERENCES supplier_capability(id) ON DELETE CASCADE,
  outcome text NOT NULL CHECK (outcome IN ('success', 'failure')),
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS supplier_health_event_window_idx
  ON supplier_health_event (supplier_account_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS generation_job (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  api_key_id text,
  billing_user_id bigint,
  source text NOT NULL CHECK (source IN ('web', 'biz', 'canary')),
  idempotency_key text,
  request_hash text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('image_generate', 'image_edit', 'video_generate')),
  routing_class text NOT NULL DEFAULT 'generic' CHECK (routing_class IN ('generic', 'firefly_only')),
  model_id text NOT NULL,
  size text,
  ratio text,
  resolution text,
  quality text,
  prompt_ciphertext text NOT NULL,
  workflow_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_format text NOT NULL DEFAULT 'b64_json' CHECK (response_format IN ('b64_json', 'url')),
  callback_url text,
  status text NOT NULL DEFAULT 'pending_billing' CHECK (status IN (
    'pending_billing', 'billing_unknown', 'queued', 'leased', 'submitting', 'running',
    'submit_unknown', 'succeeded', 'failed', 'cancelled', 'refunded'
  )),
  requested_count integer NOT NULL DEFAULT 1 CHECK (requested_count > 0),
  completed_count integer NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  billing_amount bigint NOT NULL DEFAULT 0 CHECK (billing_amount >= 0),
  deadline_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  failure_class text,
  failure_detail text,
  result_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS generation_job_tenant_idempotency_uq
  ON generation_job (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS generation_job_claim_idx
  ON generation_job (status, available_at, created_at);
CREATE INDEX IF NOT EXISTS generation_job_lease_idx
  ON generation_job (status, lease_expires_at);
CREATE INDEX IF NOT EXISTS generation_job_api_key_idx
  ON generation_job (api_key_id, created_at DESC);

CREATE TABLE IF NOT EXISTS generation_attempt (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES generation_job(id) ON DELETE CASCADE,
  attempt_no integer NOT NULL,
  output_index integer NOT NULL DEFAULT 0,
  supplier_id text NOT NULL REFERENCES supplier(id),
  supplier_model_id text,
  status text NOT NULL CHECK (status IN ('submitting', 'running', 'succeeded', 'failed', 'submit_unknown')),
  provider_request_id text,
  provider_task_id text,
  provider_http_status integer,
  failure_class text,
  failure_detail text,
  retry_after_at timestamptz,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  first_output_at timestamptz,
  finished_at timestamptz,
  latency_ms integer,
  cost_observed numeric(18, 6),
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS generation_attempt_job_idx ON generation_attempt (job_id, attempt_no);

CREATE TABLE IF NOT EXISTS supplier_lease (
  id text PRIMARY KEY,
  supplier_id text NOT NULL REFERENCES supplier(id) ON DELETE CASCADE,
  supplier_account_id text NOT NULL REFERENCES supplier_account(id) ON DELETE CASCADE,
  supplier_capability_id bigint NOT NULL REFERENCES supplier_capability(id) ON DELETE CASCADE,
  model_id text NOT NULL,
  job_id text NOT NULL REFERENCES generation_job(id) ON DELETE CASCADE,
  worker_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id)
);
CREATE INDEX IF NOT EXISTS supplier_lease_capacity_idx ON supplier_lease (supplier_id, expires_at);
CREATE INDEX IF NOT EXISTS supplier_lease_account_capacity_idx ON supplier_lease (supplier_account_id, expires_at);
CREATE INDEX IF NOT EXISTS supplier_lease_model_capacity_idx ON supplier_lease (supplier_capability_id, expires_at);

CREATE TABLE IF NOT EXISTS billing_operation (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES generation_job(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (operation IN ('reserve', 'commit', 'release', 'refund')),
  sequence integer NOT NULL DEFAULT 1,
  amount bigint NOT NULL CHECK (amount >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'executing', 'applied', 'unknown', 'failed')),
  external_reference text,
  idempotency_ref text NOT NULL,
  executor_id text,
  execution_expires_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, operation, sequence),
  UNIQUE (idempotency_ref)
);
CREATE INDEX IF NOT EXISTS billing_operation_reconcile_idx
  ON billing_operation (status, execution_expires_at);

CREATE TABLE IF NOT EXISTS artifact (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES generation_job(id) ON DELETE CASCADE,
  attempt_id text REFERENCES generation_attempt(id) ON DELETE SET NULL,
  role text NOT NULL CHECK (role IN ('reference', 'output')),
  object_key text,
  delivery_url text,
  sha256 text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  width integer,
  height integer,
  output_index integer,
  retention_expires_at timestamptz,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifact_job_idx ON artifact (job_id, role, output_index);

CREATE TABLE IF NOT EXISTS callback_delivery (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES generation_job(id) ON DELETE CASCADE,
  callback_url text NOT NULL,
  payload_json jsonb NOT NULL,
  payload_hash text NOT NULL,
  hmac_key_version text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivering', 'delivered', 'dead_letter')),
  delivery_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  response_code integer,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id)
);
CREATE INDEX IF NOT EXISTS callback_delivery_claim_idx
  ON callback_delivery (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS api_rate_limit_window (
  api_key_id text NOT NULL,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (api_key_id, window_start)
);
