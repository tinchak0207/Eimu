ALTER TABLE generation_job
  ADD COLUMN IF NOT EXISTS retry_of_job_id text REFERENCES generation_job(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS primary_artifact_id text;

CREATE INDEX IF NOT EXISTS generation_job_tenant_activity_idx
  ON generation_job (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS generation_job_retry_idx
  ON generation_job (retry_of_job_id)
  WHERE retry_of_job_id IS NOT NULL;

ALTER TABLE artifact
  ADD COLUMN IF NOT EXISTS source_artifact_id text REFERENCES artifact(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_generation_id text REFERENCES generation_job(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reference_role text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'artifact_reference_role_check'
  ) THEN
    ALTER TABLE artifact ADD CONSTRAINT artifact_reference_role_check
      CHECK (reference_role IS NULL OR reference_role IN ('general', 'character', 'product', 'style', 'composition'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS artifact_source_idx
  ON artifact (source_generation_id, source_artifact_id)
  WHERE source_generation_id IS NOT NULL OR source_artifact_id IS NOT NULL;

