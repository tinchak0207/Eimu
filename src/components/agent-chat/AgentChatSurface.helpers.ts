import { useEffect, useState } from "react";
import type { AgentSessionSummary } from "@/lib/agent-chat-client";
import { stationAuthHeaders } from "@/lib/agent-image-share";

/** 登录类错误判定：客户端缺凭证（「尚未登录」）与服务端否定登入态的文案都算，
 *  这些不是重试能解决的，必须给登录按钮（2026-09-05：agent-session-guard 的
 *  「请先登录后再使用 AI 助理。」「登录状态已失效…」此前漏在判定外，弹窗只给假「重试」）。 */
export function isAuthError(error: string): boolean {
  return error.includes("尚未登录")
    || error.includes("无法使用 Agent 助手")
    || error.includes("请先登录")
    || error.includes("登录状态已失效");
}

/**
 * GitHub OAuth 弹窗（与 Navbar 同一条链路：/api/auth/github/start popup）。
 * 完成信号三选一（2026-09-05 修「点了登录按钮回调没被接收」）：
 * ① /auth/complete 的 postMessage（成功）或首页 Navbar 转发的 github-auth-error（失败）；
 * ② storage 事件（napi_token 被弹窗写入，跨标签页可见）；
 * ③ popup.closed 轮询兜底（用户手动关窗/取消）。
 * 旧实现只认 ③——手机把弹窗开成新标签、或 window.close() 被拦时，
 * 登录早已完成却永远等不到「关闭」，重试不触发，看起来就是回调丢了。
 */
export async function startLoginThenRetry(_onDone: () => Promise<void>): Promise<void> {
  // 登录一律同窗口跳转：popup 在套壳/内嵌 webview 上会出现死窗（三个完成
  // 信号全部不来）。同窗口跳转全浏览器兼容；用户登录完回来，会话经本地
  // 存档 resume 续上，再补一次 onDone 刷新。
  window.location.href = "/api/auth/github/start";
}

/** 会话目录条目标题（双轨）：优先显示网关摘要标题（09-12 契约，opencode 首轮
 *  生成的 title，有值即用）；无标题（null/缺栏/全空白）时降级为创建时间合成的
 *  可读时间标签兜底。
 *  唯一实作留在本档（agent-chat-ui.test.ts 对它有源码锚点）；AgentSessionList
 *  透过 formatLabel prop 受注入，不复制第二份。 */
export function formatSessionLabel(it: AgentSessionSummary): string {
  const t = typeof it.title === 'string' ? it.title.trim() : '';
  if (t) return t;
  const d = new Date(it.created_at);
  const date = d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time} 的对话`;
}

/**
 * 真下载：走站内同源代理 /api/media-download（带既有鉴权标头）把位元组取回，
 * blob → objectURL → `<a download>`。**不再有 window.open 那条 fallback**——
 * 打开附件连结不是下载（暴君点名的病征）。成功回 true，失败回 false（卡片据此闪「失败」）。
 */
export async function triggerDownload(url: string, filename: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/media-download?url=${encodeURIComponent(url)}`, {
      headers: stationAuthHeaders(),
    });
    if (!res.ok) return false;
    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
    return true;
  } catch {
    return false;
  }
}

/** 300ms debounce 的字串值。 */
export function useDebouncedValue(value: string, delayMs = 300): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * outside-click 放行判定（纯函数，可直测，无须 DOM）：目标节点落在宽屏下拉的
 * anchor（historyRef）或 portal 到 document.body 的窄屏抽屉（historyDrawerRef）
 * 内，都算「浮层里面」。抽屉 portal 出去后不再被 historyRef 涵盖，这个 ref 是
 * 它唯一的放行来源；窄屏抽屉内点搜寻框、点列，全靠它不被误收。
 */
export function isInsideHistorySurface(
  anchor: { contains: (node: Node | null) => boolean } | null,
  drawer: { contains: (node: Node | null) => boolean } | null,
  target: Node | null,
): boolean {
  return Boolean(anchor?.contains(target) || drawer?.contains(target));
}
