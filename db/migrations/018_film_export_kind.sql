-- 018（2026-09-17，G4 生產端）：成片導出（POST /agent/v1/timeline/master）的產物索引。
--
-- 背景：刀 4 建了索引讀取端（artifact.metadata_json 命名空間鍵 masterExport + /v1/masters），
-- 但沒有任何寫入端——導出動作在 VPS gateway，gateway 對 DB 零存取。本輪補生產鏈：
-- gateway 導出成功 → 簽名回呼控制面 → 控制面落 generation_job + artifact。
--
-- artifact.job_id NOT NULL REFERENCES generation_job(id)：導出必須落一條 job。
-- 誠實語義：導出**是**一次真實的生成工作（ffmpeg 合成、真實計算、真實產物），
-- 給它一條 status='succeeded' 的 job 是正用不是造假；造假的是「編一個不存在的上游調用」。
--
-- kind 擴 'film_export'：與 009 擴 AV 詞表同一手法。supplier_capability.kind **不動**——
-- 該表語義是「供應商能承接什麼」，成片導出不經任何供應商（本地 ffmpeg），加了反而是假能力。
--
-- source 擴 'agent'：導出由 agent harness 代表用戶執行。舊三值沒有一個誠實：
-- 它不是 web 面板直調（'web'）、不是 B 端 /v1 直調（'biz'）、更不是金絲雀（'canary'）。

ALTER TABLE generation_job DROP CONSTRAINT IF EXISTS generation_job_kind_check;
ALTER TABLE generation_job ADD CONSTRAINT generation_job_kind_check
  CHECK (kind IN ('image_generate', 'image_edit', 'video_generate', 'tts', 'avatar', 'lipsync', 'film_export'));

ALTER TABLE generation_job DROP CONSTRAINT IF EXISTS generation_job_source_check;
ALTER TABLE generation_job ADD CONSTRAINT generation_job_source_check
  CHECK (source IN ('web', 'biz', 'canary', 'agent'));
