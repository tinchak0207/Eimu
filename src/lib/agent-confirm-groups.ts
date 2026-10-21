// 罪状 5/6（暴君人肉评测）：同批同模型的确认卡一张张叠出来，画面被
// 「将花费 6 币」刷屏。这里把 pendingConfirms 归并：费用明细完全一致的
// 同批确认（同模型同单价）合并成一张「model ×N 共 N 币」卡；不同模型
// 各自成组逐张出。纯函数，可测。

import type { AgentPendingConfirm } from "@/lib/agent-chat-types";

export interface MergedConfirmGroup {
  /** 组内全部待裁决的 requestId：一键裁决要逐笔 resolve。 */
  requestIds: string[];
  count: number;
  /** 组内金额合计（浮点求和后规整到 1e-5，不出现 0.30000000000000004）。 */
  amountCoins: number;
  /** 组内原始费用明细（组内一致，取第一条）。 */
  description?: string;
}

/** 从费用明细抽模型名：「生成 5 张图（image-5-pro），预估花费 30 币」→ image-5-pro。 */
export function modelFromDescription(description?: string): string | null {
  const m = description?.match(/[（(]([^（）()]+)[）)]/);
  const name = m?.[1].trim();
  return name ? name : null;
}

function normalizeCoins(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

/** 展示用金币数：整数直出，>=1 两位小数，<1 向下取整到万分位，绝不虚报。 */
export function formatCoins(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Number.isInteger(n)) return String(n);
  if (Math.abs(n) >= 1) return n.toFixed(2);
  return String(Math.max(0, Math.floor(n * 1e5) / 1e5));
}

/**
 * 归并确认卡：按（金额, 费用明细）分组——同批同模型的 confirm 事件这两项
 * 完全一致；不同模型（或金额不同的同模型）天然落在不同组，逐张出。
 */
export function groupPendingConfirms(confirms: AgentPendingConfirm[]): MergedConfirmGroup[] {
  const groups: MergedConfirmGroup[] = [];
  const index = new Map<string, MergedConfirmGroup>();
  for (const c of confirms) {
    const key = `${c.amountCoins}|${c.description ?? ""}`;
    const existing = index.get(key);
    if (existing) {
      existing.requestIds.push(c.requestId);
      existing.count += 1;
      existing.amountCoins = normalizeCoins(existing.amountCoins + c.amountCoins);
    } else {
      const group: MergedConfirmGroup = {
        requestIds: [c.requestId],
        count: 1,
        amountCoins: c.amountCoins,
        ...(c.description !== undefined ? { description: c.description } : {}),
      };
      groups.push(group);
      index.set(key, group);
    }
  }
  return groups;
}

/** 合并卡的主文案：「image-5-pro ×5 共 30 币」。 */
export function describeGroup(group: MergedConfirmGroup): string {
  const model = modelFromDescription(group.description);
  return `${model ?? "图片生成"} ×${group.count} 共 ${formatCoins(group.amountCoins)} 币`;
}
