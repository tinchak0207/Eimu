"use client";

import { useSyncExternalStore } from "react";
import { modelPricingRevision, subscribeModelPricing } from "@/lib/generation-model-catalog";

/**
 * 前端订阅模型定价覆写版本号：管理员改价后 applyModelPricingOverrides bump
 * revision 并通知订阅者，这个 hook 触发重新渲染，价格立刻更新。
 * server snapshot 回 0 避免 hydration mismatch（SSR 阶段 module 状态即为 0）。
 */
export function usePricingRevision(): number {
  return useSyncExternalStore(subscribeModelPricing, modelPricingRevision, () => 0);
}
