-- 先迁移再更新worker；旧worker不读取新增字段，滚动发布安全。
ALTER TABLE generation_attempt ADD COLUMN IF NOT EXISTS supplier_account_id text REFERENCES supplier_account(id) ON DELETE SET NULL;
ALTER TABLE generation_attempt ADD COLUMN IF NOT EXISTS supplier_capability_id bigint REFERENCES supplier_capability(id) ON DELETE SET NULL;
ALTER TABLE generation_attempt ADD COLUMN IF NOT EXISTS upstream_request_key text;
ALTER TABLE generation_attempt ADD COLUMN IF NOT EXISTS response_ciphertext text;
ALTER TABLE generation_attempt ADD COLUMN IF NOT EXISTS recovery_status text NOT NULL DEFAULT 'pending';
ALTER TABLE generation_attempt ADD COLUMN IF NOT EXISTS recovery_owner text;
ALTER TABLE generation_attempt ADD COLUMN IF NOT EXISTS recovery_detail text;
CREATE INDEX IF NOT EXISTS generation_attempt_response_recovery_idx ON generation_attempt(provider_next_poll_at) WHERE response_ciphertext IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS generation_attempt_upstream_request_key_uq ON generation_attempt(upstream_request_key) WHERE upstream_request_key IS NOT NULL;

-- 仅依据已交付的真实生成事实启用本次证实的参考图契约；不扩大未证实hub能力。
INSERT INTO supplier_capability (supplier_id,public_model_id,supplier_model_id,kind,edit_support,concurrency_limit,ratios,resolutions,cost_units)
SELECT supplier_id,public_model_id,supplier_model_id,'image_edit',true,concurrency_limit,ratios,resolutions,cost_units
FROM supplier_capability WHERE supplier_id='env:yyds' AND is_current AND kind='image_generate'
AND public_model_id IN('gpt-image-2.5-flare','gpt-image-2.5-sunburst')
ON CONFLICT(supplier_id,public_model_id,kind,contract_version) DO UPDATE SET edit_support=true,enabled=true;

-- 旧同步unknown没有task id，也必须进入有负责人的可观察对账队列。
UPDATE generation_attempt SET upstream_request_key=COALESCE(upstream_request_key,id),
provider_next_poll_at=COALESCE(provider_next_poll_at,now()),
provider_reconcile_deadline_at=COALESCE(provider_reconcile_deadline_at,now()+interval '24 hours'),
recovery_owner=COALESCE(recovery_owner,'control-plane:provider-reconciliation')
WHERE status='submit_unknown';

-- 旧队列的首次claim不等于开工；历史终态和在飞任务不改动。
UPDATE generation_job SET started_at=NULL WHERE status='queued' AND attempt_count=0;
UPDATE generation_job SET kind='image_edit' WHERE status='queued' AND kind='image_generate'
AND CASE WHEN jsonb_typeof(workflow_json->'references')='array' THEN jsonb_array_length(workflow_json->'references')>0 ELSE false END;

ALTER TABLE generation_job ADD COLUMN IF NOT EXISTS queue_deadline_at timestamptz;
ALTER TABLE generation_job ADD COLUMN IF NOT EXISTS execution_deadline_at timestamptz;
UPDATE generation_job SET queue_deadline_at=deadline_at WHERE status='queued' AND queue_deadline_at IS NULL;

ALTER TABLE generation_job ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;

ALTER TABLE generation_attempt ADD COLUMN IF NOT EXISTS provider_submission_started_at timestamptz;
