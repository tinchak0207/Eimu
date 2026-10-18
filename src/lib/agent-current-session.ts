// 活跃会话的唯读镜像（给另一棵元件树显示用，非真源）。
//
// 真源仍是 useAgentChat 的 sessionId（AgentChatSurface 持有）。这个模组只是模组级、
// 纯记忆体、不持久化、不做响应式的镜像：MobileSidebar 的「当前会话」高亮需要读到
// 活跃会话 id，但它挂在 root layout 的 Navbar 下、与 AgentChatSurface 不住同一棵树；
// 又不能只读 localStorage 存档——首页的还原／开新路径会把存档 consume 掉
// （use-agent-chat 的 clearPersisted），使用者先载入首页再点汉堡就永远读不到。
// 唯一写者＝AgentChatSurface（useEffect 同步 sessionId）；读者在侧栏开启时一次性
// 取值，不订阅、不重绘。

import { getStoredUser } from "./new-api-client";

let currentAgentSessionId: string | null = null;
let currentOwnerId: number | null = null;

/** 唯一写者：AgentChatSurface（把 useAgentChat 的 sessionId 同步进来）。 */
export function setCurrentAgentSession(id: string | null): void {
  currentAgentSessionId = id;
  try { currentOwnerId = getStoredUser()?.id ?? null; } catch { currentOwnerId = null; }
}

/** 读者：MobileSidebar 开启时一次性读取；agent 面未挂载／尚未建号回 null。 */
export function getCurrentAgentSession(): string | null {
  try {
    const ownerId = getStoredUser()?.id ?? null;
    return ownerId !== null && ownerId === currentOwnerId ? currentAgentSessionId : null;
  } catch { return null; }
}
