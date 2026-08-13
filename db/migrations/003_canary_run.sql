CREATE TABLE IF NOT EXISTS canary_run (
  id text PRIMARY KEY,
  job_id text REFERENCES generation_job(id) ON DELETE SET NULL,
  supplier_id text NOT NULL,
  model_id text NOT NULL,
  kind text NOT NULL,
  ratio text,
  resolution text,
  outcome text NOT NULL CHECK (outcome IN ('pending','succeeded','failed','stale_no_pickup','stale_stuck')),
  decoded_mime_type text,
  decoded_width integer,
  decoded_height integer,
  decoded_sha256 text,
  first_hop_endpoint_label text,
  failure_detail text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS canary_run_recent_idx ON canary_run (model_id, kind, started_at DESC);
