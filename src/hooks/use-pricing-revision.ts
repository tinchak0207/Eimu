"use client";

import { useSyncExternalStore } from "react";
import { modelPricingRevision, subscribeModelPricing } from "@/lib/generation-model-catalog";

/**
 * 前端訂閱模型定價覆寫版本號：管理員改價後 applyModelPricingOverrides bump
 * revision 並通知訂閱者，這個 hook 觸發重新渲染，價格立刻更新。
 * server snapshot 回 0 避免 hydration mismatch（SSR 階段 module 狀態即為 0）。
 */
export function usePricingRevision(): number {
  return useSyncExternalStore(subscribeModelPricing, modelPricingRevision, () => 0);
}
