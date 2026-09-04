-- 013: job_events — append-only 事件賬本（P1.5 中控外科手術，暴君 2026-08-28 點名）。
--
-- ┌─────────────────────────────────────────────────────────────────────────┐
-- │ 鐵律（append-only 賬本，違者 = 中控撒謊，立即返工）：                     │
-- │ 1. 本表只允許 INSERT。禁止 UPDATE / DELETE（含人工排障操作、含遷移腳本）。│
-- │ 2. generation_job 的狀態欄位必須由事件寫出：寫狀態必寫事件，             │
-- │    無事件的狀態遷移 = bug。                                              │
-- │ 3. 上游錯誤原文入庫（upstream_raw）不改寫、不翻譯、不截斷語義；          │
-- │    任何「話術」（友善文案、歸因、道歉）只許存在於展示層。                │
-- └─────────────────────────────────────────────────────────────────────────┘
--
-- 不加 FOREIGN KEY：賬本必須在 job 行被清理/歸檔後仍然存活（append-only 與
-- ON DELETE CASCADE 互斥）。job_id 的正確性由寫入方（emitJobEvent）保證。

CREATE TABLE IF NOT EXISTS job_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  event text NOT NULL,
  actor text,
  upstream_raw text,
  detail jsonb
);

-- 時間線主查詢路徑：一個 job 的全部事件按時間排序。
CREATE INDEX IF NOT EXISTS job_events_job_at_idx
  ON job_events (job_id, at, id);

-- 滯留/死因聚合路徑：按事件類型掃描（如 billing_unknown、zombie_reclaimed）。
CREATE INDEX IF NOT EXISTS job_events_event_at_idx
  ON job_events (event, at);
