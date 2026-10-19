-- 014: cangyuansuanli supplier adapter type（/v1/videos openai-video 异步，seedance 2.5/2.0 主渠道）
ALTER TABLE supplier DROP CONSTRAINT IF EXISTS supplier_adapter_type_check;
ALTER TABLE supplier ADD CONSTRAINT supplier_adapter_type_check CHECK (adapter_type IN ('adobe2api','openai_images','minimax','did','filmera','metaso','openai_video'));
