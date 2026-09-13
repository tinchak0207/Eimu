-- routing_class 增加 'hub_only'：Gatus uptime probe（routing_hint=hub）固定路由到 hub 渠道
-- （supplier.id = 'env:hublinuxdo'），不再被 supply_tier 排序排到 adobe2api。
-- 001 中該 CHECK 是匿名 inline 約束，Postgres 默認命名為 generation_job_routing_class_check。
ALTER TABLE generation_job DROP CONSTRAINT generation_job_routing_class_check;
ALTER TABLE generation_job
  ADD CONSTRAINT generation_job_routing_class_check
  CHECK (routing_class IN ('generic', 'firefly_only', 'hub_only'));
