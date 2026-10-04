-- 016: provider reconciliation（INC-0831 中控打掉上游成功任务事故的架构级整改）。
--
-- 事故闭环：cangyuansuanli 10 笔视频任务上游全部成功，中控轮询超时后走
-- failGenerationJob(deadline_exceeded) + refund，成品 URL 从此无人认领。
-- 根因：provider task id 没有对帐闭环——task id 落了 attempt 行（甚至落了事件），
-- 但没有任何循环再按 task id 去问上游「你好了没」。
--
-- 本迁移把「上游任务」变成可恢复的 durable execution：
--   1. generation_attempt 增加对帐栏位（provider_state / 排程 / 租约 / 次数 / 原文）。
--   2. artifact (job_id, output_index) 唯一化：晚到成品幂等落地，同一输出永不重复列。
--   3. 存量 failed/submit_unknown 且带 task id 的 attempt 全部回填进对帐队列
--      （含本次事故的 10 笔 cangyuansuanli 任务——上游 CDN URL 若仍在即可救回）。

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

-- 对帐扫描主路径：到期未轮询、仍 unknown/running 的上游任务。
CREATE INDEX IF NOT EXISTS generation_attempt_reconcile_due_idx
  ON generation_attempt (provider_next_poll_at)
  WHERE provider_state IN ('unknown', 'running') AND provider_next_poll_at IS NOT NULL;

-- 按 task id 对账的直查路径（probe / 人工排障 / 事故复盘）。
CREATE INDEX IF NOT EXISTS generation_attempt_provider_task_idx
  ON generation_attempt (provider_task_id)
  WHERE provider_task_id IS NOT NULL;

-- 存量回填：已提交过上游（有 task id）但被旧中控判死/挂 unknown 的 attempt，
-- 全部纳入对帐窗口（24h）。provider_next_poll_at=now() → 部署后第一个 maintenance 立刻开工。
UPDATE generation_attempt
SET provider_state = 'running',
    provider_next_poll_at = now(),
    provider_reconcile_deadline_at = now() + interval '24 hours'
WHERE provider_task_id IS NOT NULL
  AND status IN ('failed', 'submit_unknown');

-- ---------------------------------------------------------------------------
-- artifact 输出唯一性：先清历史重复（保留最早一行为 canonical），再加 partial
-- unique index。之后 recordArtifact 走 ON CONFLICT DO NOTHING，同一输出
-- （worker 先到 or 对帐晚到）永远只有一行。
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
