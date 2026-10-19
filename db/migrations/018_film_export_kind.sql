-- 018（2026-09-17，G4 生产端）：成片导出（POST /agent/v1/timeline/master）的产物索引。
--
-- 背景：刀 4 建了索引读取端（artifact.metadata_json 命名空间键 masterExport + /v1/masters），
-- 但没有任何写入端——导出动作在 VPS gateway，gateway 对 DB 零存取。本轮补生产链：
-- gateway 导出成功 → 签名回呼控制面 → 控制面落 generation_job + artifact。
--
-- artifact.job_id NOT NULL REFERENCES generation_job(id)：导出必须落一条 job。
-- 诚实语义：导出**是**一次真实的生成工作（ffmpeg 合成、真实计算、真实产物），
-- 给它一条 status='succeeded' 的 job 是正用不是造假；造假的是「编一个不存在的上游调用」。
--
-- kind 扩 'film_export'：与 009 扩 AV 词表同一手法。supplier_capability.kind **不动**——
-- 该表语义是「供应商能承接什么」，成片导出不经任何供应商（本地 ffmpeg），加了反而是假能力。
--
-- source 扩 'agent'：导出由 agent harness 代表用户执行。旧三值没有一个诚实：
-- 它不是 web 面板直调（'web'）、不是 B 端 /v1 直调（'biz'）、更不是金丝雀（'canary'）。

ALTER TABLE generation_job DROP CONSTRAINT IF EXISTS generation_job_kind_check;
ALTER TABLE generation_job ADD CONSTRAINT generation_job_kind_check
  CHECK (kind IN ('image_generate', 'image_edit', 'video_generate', 'tts', 'avatar', 'lipsync', 'film_export'));

ALTER TABLE generation_job DROP CONSTRAINT IF EXISTS generation_job_source_check;
ALTER TABLE generation_job ADD CONSTRAINT generation_job_source_check
  CHECK (source IN ('web', 'biz', 'canary', 'agent'));
