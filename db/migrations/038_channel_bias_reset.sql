-- 038: channel_bias_reset —— 渠道 bias 刷新水位（src/lib/bias-reset.ts）。
--
-- 为什么需要它：平台对渠道的全部负面判定都来自**历史证据**——
--   ① 72h `generation_job` 终态 → 断路器 open（model-availability-gate）；
--   ② 24h routing events → `last_24h` 零交付闸（agent 的 video-model-select
--      `disprovenRecently` + 网关 M4 `override_zero_delivery`）与「渠道欠费」信号；
--   ③ `supplier`/`supplier_account` 的 health_status/cooldown/failure_count → 调度可用性。
-- 渠道从坏变好（上游修好、我方修好适配器）那一刻，旧证据在数学上仍然成立：判定没有
-- 「重新计时」的入口。后果实测（2026-10-12 miaowuai 接入）：适配器修好、渠道实测 200
-- 出片 54 秒，agent 仍因「近 24h 3 单零交付」拒绝下单，只能干等 24h 自然过期。
--
-- 机制：一行 = 一条**重置水位**。某 model／supplier 在 `reset_at` **之前**的负面证据
-- 不再计入判定；证据本身保留在库里（不删除、可审计、可反查），只是被判据忽略。
-- 写入方唯一入口：`tools/refresh-channel-bias.ts`（同时复位供应商调度态、清理窗口内
-- 健康事件），必须带 `reason` 与 `actor`——谁在什么时候、凭什么判断渠道已修好。
--
-- 读方（fail-open）：表不存在（本迁移未跑）或 DB 不可达 → 空水位 → 判据退化为原行为，
-- 绝不因为水位读不到而放行或拦截任何模型。
--
-- 不是帐本，不参与计费；不改写任何历史行的语义（无 UPDATE/DELETE 历史证据的必要）。

CREATE TABLE IF NOT EXISTS channel_bias_reset (
  scope      text NOT NULL CHECK (scope IN ('model', 'supplier')),
  target     text NOT NULL,
  reset_at   timestamptz NOT NULL,
  reason     text NOT NULL,
  actor      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, target)
);

-- 刷新只关心「某 target 的当前水位」：主键即查询路径；另按时间列出最近刷新做审计视图。
CREATE INDEX IF NOT EXISTS channel_bias_reset_reset_at_idx ON channel_bias_reset (reset_at DESC);
