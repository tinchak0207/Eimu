-- 034: 模型路由熱覆寫（2026-10-01 路由架構收口）。
-- 調度順序的唯一真源是程式碼 src/lib/model-routes.config.ts 的 MODEL_ROUTES；
-- 本表只存 admin 在後台對某模型的「整條路由」覆寫（有序渠道 label 陣列），
-- 立即生效、不需部署，seed 永不觸碰。刪行＝回到程式碼預設。
CREATE TABLE IF NOT EXISTS model_route_override (
  model_id text PRIMARY KEY,
  route text[] NOT NULL,
  note text,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
