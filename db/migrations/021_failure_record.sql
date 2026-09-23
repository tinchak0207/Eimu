-- 021: 版本化失敗記錄（FG-01，2026-09-23 waoowaoo 機制 digest 第 4 條）。
--
-- 病灶：generation_attempt.failure_detail 是扁平字串、failure_class 是封閉枚舉。
-- 上游原始錯誤（name/message/code/status/requestId/metadata/cause 遞迴）在分類的
-- 那一刻被壓成一句人話，之後無法還原上游到底說了什麼；產品解釋與原生事實同欄位。
--
-- 本遷移只做一件事：給既有 job / attempt 各加一個 jsonb 欄位存 versioned
-- FailureRecord。**不新造第二條帳務/事件通道**——job_events append-only 帳本與
-- billing_operation 語義一字不動，錯誤原文照既有路徑以 upstream_raw 進帳本。
--
-- 版本閘：欄位只能存版本 1 的記錄（`->>'version' = '1'`）。未來升版必須另開遷移
-- 放寬此約束並補解析分支，禁止就地改語義（舊記錄不會被靜默讀成新版本）。

ALTER TABLE generation_attempt
  ADD COLUMN IF NOT EXISTS failure_record_json jsonb;

ALTER TABLE generation_job
  ADD COLUMN IF NOT EXISTS failure_record_json jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'generation_attempt_failure_record_version_check') THEN
    ALTER TABLE generation_attempt
      ADD CONSTRAINT generation_attempt_failure_record_version_check
      CHECK (failure_record_json IS NULL OR failure_record_json->>'version' = '1');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'generation_job_failure_record_version_check') THEN
    ALTER TABLE generation_job
      ADD CONSTRAINT generation_job_failure_record_version_check
      CHECK (failure_record_json IS NULL OR failure_record_json->>'version' = '1');
  END IF;
END $$;

-- 排障/統計的直查路徑：按產品分類挑失敗記錄（解釋層查詢，不觸碰原生欄位）。
CREATE INDEX IF NOT EXISTS generation_attempt_failure_record_class_idx
  ON generation_attempt ((failure_record_json->'explanation'->>'failureClass'))
  WHERE failure_record_json IS NOT NULL;
