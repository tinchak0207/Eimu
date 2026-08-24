-- B 端批量生成編排層（Topview 對稱差 #1：成片可批量穩定交付）。
--
-- generation_batches 只是「批的殼」：每個 item 仍然是一條 generation_job，
-- 走同一條 submitGenerationCommand 提交/計費/調度路徑；本表只記錄批的
-- 歸屬（tenant）、冪等鍵與逐項驗證失敗快照。
--
-- max_in_flight 目前是聲明性欄位：可承諾併發由平台 supplier_lease /
-- scheduler 的池化併發治理（batch 全量提交 + scheduler 排隊），batch
-- 不自建第二套節流器。

CREATE TABLE IF NOT EXISTS generation_batches (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
  total_count integer NOT NULL CHECK (total_count > 0),
  max_in_flight integer,
  idempotency_key text,
  -- 與 generation_job.request_hash 同源的規範化請求雜湊：同一 Idempotency-Key
  -- 重放不同內容時據此回 409，而不是靜默退回舊批。
  request_hash text NOT NULL,
  -- 逐項驗證/提交失敗的快照 [{index, code, message, type}]：
  -- 這些項目永遠不會變成 generation_job，聚合視圖仍要能按 index 對回去。
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

-- batch_id / batch_index 可空：舊數據與非批量任務不受影響。
ALTER TABLE generation_job ADD COLUMN IF NOT EXISTS batch_id text
  REFERENCES generation_batches(id) ON DELETE SET NULL;
ALTER TABLE generation_job ADD COLUMN IF NOT EXISTS batch_index integer;
CREATE INDEX IF NOT EXISTS generation_job_batch_idx
  ON generation_job (batch_id, batch_index) WHERE batch_id IS NOT NULL;
