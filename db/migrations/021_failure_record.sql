-- 021: 版本化失败记录（FG-01，2026-09-23 waoowaoo 机制 digest 第 4 条）。
--
-- 病灶：generation_attempt.failure_detail 是扁平字串、failure_class 是封闭枚举。
-- 上游原始错误（name/message/code/status/requestId/metadata/cause 递回）在分类的
-- 那一刻被压成一句人话，之后无法还原上游到底说了什么；产品解释与原生事实同栏位。
--
-- 本迁移只做一件事：给既有 job / attempt 各加一个 jsonb 栏位存 versioned
-- FailureRecord。**不新造第二条帐务/事件通道**——job_events append-only 帐本与
-- billing_operation 语义一字不动，错误原文照既有路径以 upstream_raw 进帐本。
--
-- 版本闸：栏位只能存版本 1 的记录（`->>'version' = '1'`）。未来升版必须另开迁移
-- 放宽此约束并补解析分支，禁止就地改语义（旧记录不会被静默读成新版本）。

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

-- 排障/统计的直查路径：按产品分类挑失败记录（解释层查询，不触碰原生栏位）。
CREATE INDEX IF NOT EXISTS generation_attempt_failure_record_class_idx
  ON generation_attempt ((failure_record_json->'explanation'->>'failureClass'))
  WHERE failure_record_json IS NOT NULL;
