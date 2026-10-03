// 跨元件動作橋：助理面（AgentChatSurface）掛監聽，任何元件（側欄）派動作。
//
// 助理面的頂欄鈕（資產包／對話歷史／助理設定／新對話／直接生成）在窄屏被收掉，
// 改由左側側欄叫動。側欄與 AgentChatSurface 不住同一棵元件樹（側欄掛在 root
// layout 的 Navbar 下），所以走 `window` 上的 CustomEvent——與
// AssetReviewPanel 的 openReviewPanel()／CanvasEmbed 的監聽同一個既有形狀，
// 不另造 registry／singleton／context。
//
// 為什麼 cancelable：派發端要能知道「有沒有人接走」。沒有宿主掛載（助理面不在
// 當前頁）時，呼叫端必須退回自己的導航（例如連 `/?agent=1`），而不是靜默什麼
// 都不做。`dispatchEvent` 回 false 代表某個監聽者呼叫過 preventDefault，即視為
// 已處理。
// 為什麼回 boolean：把「有無宿主」這個事實交給呼叫端決定退路，橋本身不含任何
// 導航或產品邏輯。

export type AgentSurfaceAction = "assets" | "history" | "settings" | "new-session" | "exit";

export const AGENT_SURFACE_ACTION_EVENT = "eimu:agent-surface-action";

export interface AgentSurfaceActionDetail {
  action: AgentSurfaceAction;
}

/**
 * 派一個助理面動作。
 * 回 true＝有宿主接走（事件已被 preventDefault）；false＝助理面沒掛載（
 * SSR 或不在該頁），呼叫端自行退回導航。
 */
export function requestAgentSurfaceAction(action: AgentSurfaceAction): boolean {
  if (typeof window === "undefined") return false;
  const event = new CustomEvent<AgentSurfaceActionDetail>(AGENT_SURFACE_ACTION_EVENT, {
    detail: { action },
    cancelable: true,
  });
  return !window.dispatchEvent(event);
}

/**
 * 助理面掛監聽。onAction 回 true 表示自己處理掉了，本函式代為 preventDefault，
 * 讓派發端知道有人接走。回傳退訂函式。
 */
export function subscribeAgentSurfaceActions(
  onAction: (action: AgentSurfaceAction) => boolean,
): () => void {
  const handler = (event: Event): void => {
    const action = (event as CustomEvent<AgentSurfaceActionDetail>).detail?.action;
    if (!action) return;
    if (onAction(action) && event.cancelable) event.preventDefault();
  };
  window.addEventListener(AGENT_SURFACE_ACTION_EVENT, handler);
  return () => window.removeEventListener(AGENT_SURFACE_ACTION_EVENT, handler);
}
