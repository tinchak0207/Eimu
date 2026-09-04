-- 016: provider reconciliation（INC-0831 中控打掉上游成功任務事故的架構級整改）。
--
-- 事故閉環：cangyuansuanli 10 筆視頻任務上游全部成功，中控輪詢超時後走
-- failGenerationJob(deadline_exceeded) + refund，成品 URL 從此無人認領。
-- 根因：provider task id 沒有對帳閉環——task id 落了 attempt 行（甚至落了事件），
-- 但沒有任何循環再按 task id 去問上游「你好了沒」。
--
-- 本遷移把「上游任務」變成可恢復的 durable execution：
--   1. generation_attempt 增加對帳欄位（provider_state / 排程 / 租約 / 次數 / 原文）。
--   2. artifact (job_id, output_index) 唯一化：晚到成品冪等落地，同一輸出永不重複列。
--   3. 存量 failed/submit_unknown 且帶 task id 的 attempt 全部回填進對帳隊列
--      （含本次事故的 10 筆 cangyuansuanli 任務——上游 CDN URL 若仍在即可救回）。

ALTER TABLE generation_attempt
  ADD COLUMN IF NOT EXISTS provider_state text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS provider_protocol text,
  ADD COLUMN IF NOT EXISTS provider_last_polled_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_next_poll_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_reconcile_deadline_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_poll_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_result_json jsonb,
  ADD COLUMN IF NOT EXISTS reconcile_lease_owner text,
  ADD COLUMN IF NOT EXISTS reconcile_lease_expires_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'generation_attempt_provider_state_check') THEN
    ALTER TABLE generation_attempt
      ADD CONSTRAINT generation_attempt_provider_state_check
      CHECK (provider_state IN ('unknown', 'running', 'succeeded', 'failed'));
  END IF;
END $$;

-- 對帳掃描主路徑：到期未輪詢、仍 unknown/running 的上游任務。
CREATE INDEX IF NOT EXISTS generation_attempt_reconcile_due_idx
  ON generation_attempt (provider_next_poll_at)
  WHERE provider_state IN ('unknown', 'running') AND provider_next_poll_at IS NOT NULL;

-- 按 task id 對賬的直查路徑（probe / 人工排障 / 事故復盤）。
CREATE INDEX IF NOT EXISTS generation_attempt_provider_task_idx
  ON generation_attempt (provider_task_id)
  WHERE provider_task_id IS NOT NULL;

-- 存量回填：已提交過上游（有 task id）但被舊中控判死/掛 unknown 的 attempt，
-- 全部納入對帳窗口（24h）。provider_next_poll_at=now() → 部署後第一個 maintenance 立刻開工。
UPDATE generation_attempt
SET provider_state = 'running',
    provider_next_poll_at = now(),
    provider_reconcile_deadline_at = now() + interval '24 hours'
WHERE provider_task_id IS NOT NULL
  AND status IN ('failed', 'submit_unknown');

-- ---------------------------------------------------------------------------
-- artifact 輸出唯一性：先清歷史重複（保留最早一行為 canonical），再加 partial
-- unique index。之後 recordArtifact 走 ON CONFLICT DO NOTHING，同一輸出
-- （worker 先到 or 對帳晚到）永遠只有一行。
-- ---------------------------------------------------------------------------
DELETE FROM artifact a
USING artifact b
WHERE a.role = 'output' AND b.role = 'output'
  AND a.output_index IS NOT NULL AND b.output_index IS NOT NULL
  AND a.job_id = b.job_id AND a.output_index = b.output_index
  AND (a.created_at, a.id) > (b.created_at, b.id);

CREATE UNIQUE INDEX IF NOT EXISTS artifact_output_canonical_uq
  ON artifact (job_id, output_index)
  WHERE role = 'output' AND output_index IS NOT NULL;
