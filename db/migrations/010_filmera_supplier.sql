-- filmera.ai 渠道：adapter_type 白名单加入 'filmera'。
-- seed-generation-suppliers.ts 负责实际播种 supplier/capability（worker 启动时幂等 upsert）。
ALTER TABLE supplier DROP CONSTRAINT IF EXISTS supplier_adapter_type_check;
ALTER TABLE supplier ADD CONSTRAINT supplier_adapter_type_check CHECK (adapter_type IN ('adobe2api','openai_images','minimax','did','filmera'));
