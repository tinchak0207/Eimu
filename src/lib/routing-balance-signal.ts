// R7-E（2026-08-29）：渠道餘額信號——從最近 routing events 的 attempts 判
// 「連續 quota_exhausted 斷流」。channel 欠費時上游會連續拒單，agent 憑
// availability=unavailable + note 在提交前就看到，不再把任務燒進死隊列。
// 純函數：不觸碰外部狀態；探測端故障時路由側照舊，本信號只做覆寫輸入。

import type { RoutingEvent } from "./routing-telemetry";

export interface ChannelBalanceSignal {
  /** exhausted = 連續欠費斷流；ok = 有成功或非欠費收尾，無信號。 */
  status: "exhausted" | "ok";
  /** 連續 quota_exhausted 筆數（exhausted 時 ≥2）。 */
  consecutiveQuotaFailures: number;
}

/** 連續欠費斷流的判定門檻：≥2 筆 quota_exhausted 且其後無任何成功。 */
const EXHAUSTED_STREAK_MIN = 2;

export function summarizeChannelBalance(events: RoutingEvent[]): Map<string, ChannelBalanceSignal> {
  // 每模型收集 (ok, reason) 平坦序列，按事件時間升冪（listRoutingEvents 已保證，
  // 但這裡再 sort 一次自防：遙測順序屬於實現細節，不該耦合進判定）。
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
      if (attempt.ok) break; // 尾部有成功 → 渠道活著，無信號
      if (attempt.reason === "quota_exhausted") streak += 1;
      else break; // 非欠費失敗收尾 → 是別的病，不冒充欠費
    }
    if (streak >= EXHAUSTED_STREAK_MIN) {
      signals.set(modelId, { status: "exhausted", consecutiveQuotaFailures: streak });
    }
  }
  return signals;
}
