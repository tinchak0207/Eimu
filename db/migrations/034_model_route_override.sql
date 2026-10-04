-- 034: 模型路由热覆写（2026-10-01 路由架构收口）。
-- 调度顺序的唯一真源是程式码 src/lib/model-routes.config.ts 的 MODEL_ROUTES；
-- 本表只存 admin 在后台对某模型的「整条路由」覆写（有序渠道 label 阵列），
-- 立即生效、不需部署，seed 永不触碰。删行＝回到程式码预设。
CREATE TABLE IF NOT EXISTS model_route_override (
  model_id text PRIMARY KEY,
  route text[] NOT NULL,
  note text,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
