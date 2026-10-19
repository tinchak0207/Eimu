-- 011: metaso supplier adapter type（metaso.cn MiniMax-H3 文生视频）
ALTER TABLE supplier DROP CONSTRAINT IF EXISTS supplier_adapter_type_check;
ALTER TABLE supplier ADD CONSTRAINT supplier_adapter_type_check CHECK (adapter_type IN ('adobe2api','openai_images','minimax','did','filmera','metaso'));
