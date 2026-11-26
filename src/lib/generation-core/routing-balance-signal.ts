// R7-E（2026-08-29）：渠道余额信号——从最近 routing events 的 attempts 判
// 「连续 quota_exhausted 断流」。channel 欠费时上游会连续拒单，agent 凭
// availability=unavailable + note 在提交前就看到，不再把任务烧进死队列。
// 纯函数：不触碰外部状态；探测端故障时路由侧照旧，本信号只做覆写输入。

import type { RoutingEvent } from "./routing-telemetry";

export interface ChannelBalanceSignal {
  /** exhausted = 连续欠费断流；ok = 有成功或非欠费收尾，无信号。 */
  status: "exhausted" | "ok";
  /** 连续 quota_exhausted 笔数（exhausted 时 ≥2）。 */
  consecutiveQuotaFailures: number;
}

/** 连续欠费断流的判定门槛：≥2 笔 quota_exhausted 且其后无任何成功。 */
const EXHAUSTED_STREAK_MIN = 2;

export function summarizeChannelBalance(events: RoutingEvent[]): Map<string, ChannelBalanceSignal> {
  // 每模型收集 (ok, reason) 平坦序列，按事件时间升幂（listRoutingEvents 已保证，
  // 但这里再 sort 一次自防：遥测顺序属于实现细节，不该耦合进判定）。
  const perModel = new Map<string, { ok: boolean; reason?: string }[]>();
  for (const event of [...events].sort((a, b) => a.ts - b.ts)) {
    let list = perModel.get(event.modelId);
    if (!list) perModel.set(event.modelId, (list = []));
    for (const attempt of event.attempts ?? []) {
      list.push({ ok: attempt.ok, reason: attempt.reason });
    }
  }

  const signals = new Map<string, ChannelBalanceSignal>();
  for (const [modelId, attempts] of perModel) {
    let streak = 0;
    for (let i = attempts.length - 1; i >= 0; i--) {
      const attempt = attempts[i];
      if (attempt.ok) break; // 尾部有成功 → 渠道活著，无信号
      if (attempt.reason === "quota_exhausted") streak += 1;
      else break; // 非欠费失败收尾 → 是别的病，不冒充欠费
    }
    if (streak >= EXHAUSTED_STREAK_MIN) {
      signals.set(modelId, { status: "exhausted", consecutiveQuotaFailures: streak });
    }
  }
  return signals;
}
