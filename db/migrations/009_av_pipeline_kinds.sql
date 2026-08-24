-- 009: AV pipeline kinds (tts / avatar / lipsync) + minimax / did adapter types
ALTER TABLE generation_job DROP CONSTRAINT IF EXISTS generation_job_kind_check;
ALTER TABLE generation_job ADD CONSTRAINT generation_job_kind_check CHECK (kind IN ('image_generate','image_edit','video_generate','tts','avatar','lipsync'));
ALTER TABLE supplier_capability DROP CONSTRAINT IF EXISTS supplier_capability_kind_check;
ALTER TABLE supplier_capability ADD CONSTRAINT supplier_capability_kind_check CHECK (kind IN ('image_generate','image_edit','video_generate','tts','avatar','lipsync'));
ALTER TABLE supplier DROP CONSTRAINT IF EXISTS supplier_adapter_type_check;
ALTER TABLE supplier ADD CONSTRAINT supplier_adapter_type_check CHECK (adapter_type IN ('adobe2api','openai_images','minimax','did'));
