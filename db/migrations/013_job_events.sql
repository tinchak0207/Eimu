-- 013: job_events — append-only 事件账本（P1.5 中控外科手术，项目负责人 2026-08-28 点名）。
--
-- ┌─────────────────────────────────────────────────────────────────────────┐
-- │ 铁律（append-only 账本，违者 = 中控撒谎，立即返工）：                     │
-- │ 1. 本表只允许 INSERT。禁止 UPDATE / DELETE（含人工排障操作、含迁移脚本）。│
-- │ 2. generation_job 的状态栏位必须由事件写出：写状态必写事件，             │
-- │    无事件的状态迁移 = bug。                                              │
-- │ 3. 上游错误原文入库（upstream_raw）不改写、不翻译、不截断语义；          │
-- │    任何「话术」（友善文案、归因、道歉）只许存在于展示层。                │
-- └─────────────────────────────────────────────────────────────────────────┘
--
-- 不加 FOREIGN KEY：账本必须在 job 行被清理/归档后仍然存活（append-only 与
-- ON DELETE CASCADE 互斥）。job_id 的正确性由写入方（emitJobEvent）保证。

CREATE TABLE IF NOT EXISTS job_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  event text NOT NULL,
  actor text,
  upstream_raw text,
  detail jsonb
);

-- 时间线主查询路径：一个 job 的全部事件按时间排序。
CREATE INDEX IF NOT EXISTS job_events_job_at_idx
  ON job_events (job_id, at, id);

-- 滞留/死因聚合路径：按事件类型扫描（如 billing_unknown、zombie_reclaimed）。
CREATE INDEX IF NOT EXISTS job_events_event_at_idx
  ON job_events (event, at);
