-- B 端批量生成编排层（Topview 对称差 #1：成片可批量稳定交付）。
--
-- generation_batches 只是「批的壳」：每个 item 仍然是一条 generation_job，
-- 走同一条 submitGenerationCommand 提交/计费/调度路径；本表只记录批的
-- 归属（tenant）、幂等键与逐项验证失败快照。
--
-- max_in_flight 目前是声明性栏位：可承诺并发由平台 supplier_lease /
-- scheduler 的池化并发治理（batch 全量提交 + scheduler 排队），batch
-- 不自建第二套节流器。

CREATE TABLE IF NOT EXISTS generation_batches (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
  total_count integer NOT NULL CHECK (total_count > 0),
  max_in_flight integer,
  idempotency_key text,
  -- 与 generation_job.request_hash 同源的规范化请求杂凑：同一 Idempotency-Key
  -- 重放不同内容时据此回 409，而不是静默退回旧批。
  request_hash text NOT NULL,
  -- 逐项验证/提交失败的快照 [{index, code, message, type}]：
  -- 这些项目永远不会变成 generation_job，聚合视图仍要能按 index 对回去。
  failed_items_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS generation_batches_tenant_idempotency_uq
  ON generation_batches (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS generation_batches_tenant_idx
  ON generation_batches (tenant_id, created_at DESC);

-- batch_id / batch_index 可空：旧数据与非批量任务不受影响。
ALTER TABLE generation_job ADD COLUMN IF NOT EXISTS batch_id text
  REFERENCES generation_batches(id) ON DELETE SET NULL;
ALTER TABLE generation_job ADD COLUMN IF NOT EXISTS batch_index integer;
CREATE INDEX IF NOT EXISTS generation_job_batch_idx
  ON generation_job (batch_id, batch_index) WHERE batch_id IS NOT NULL;
