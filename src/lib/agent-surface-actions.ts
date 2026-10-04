// 跨元件动作桥：助理面（AgentChatSurface）挂监听，任何元件（侧栏）派动作。
//
// 助理面的顶栏钮（资产包／对话历史／助理设定／新对话／直接生成）在窄屏被收掉，
// 改由左侧侧栏叫动。侧栏与 AgentChatSurface 不住同一棵元件树（侧栏挂在 root
// layout 的 Navbar 下），所以走 `window` 上的 CustomEvent——与
// AssetReviewPanel 的 openReviewPanel()／CanvasEmbed 的监听同一个既有形状，
// 不另造 registry／singleton／context。
//
// 为什么 cancelable：派发端要能知道「有没有人接走」。没有宿主挂载（助理面不在
// 当前页）时，呼叫端必须退回自己的导航（例如连 `/?agent=1`），而不是静默什么
// 都不做。`dispatchEvent` 回 false 代表某个监听者呼叫过 preventDefault，即视为
// 已处理。
// 为什么回 boolean：把「有无宿主」这个事实交给呼叫端决定退路，桥本身不含任何
// 导航或产品逻辑。

export type AgentSurfaceAction = "assets" | "history" | "settings" | "new-session" | "exit";

export const AGENT_SURFACE_ACTION_EVENT = "eimu:agent-surface-action";

export interface AgentSurfaceActionDetail {
  action: AgentSurfaceAction;
}

/**
 * 派一个助理面动作。
 * 回 true＝有宿主接走（事件已被 preventDefault）；false＝助理面没挂载（
 * SSR 或不在该页），呼叫端自行退回导航。
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
 * 助理面挂监听。onAction 回 true 表示自己处理掉了，本函式代为 preventDefault，
 * 让派发端知道有人接走。回传退订函式。
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
