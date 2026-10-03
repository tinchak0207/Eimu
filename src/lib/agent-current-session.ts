// 活躍會話的唯讀鏡像（給另一棵元件樹顯示用，非真源）。
//
// 真源仍是 useAgentChat 的 sessionId（AgentChatSurface 持有）。這個模組只是模組級、
// 純記憶體、不持久化、不做響應式的鏡像：MobileSidebar 的「當前會話」高亮需要讀到
// 活躍會話 id，但它掛在 root layout 的 Navbar 下、與 AgentChatSurface 不住同一棵樹；
// 又不能只讀 localStorage 存檔——首頁的還原／開新路徑會把存檔 consume 掉
// （use-agent-chat 的 clearPersisted），使用者先載入首頁再點漢堡就永遠讀不到。
// 唯一寫者＝AgentChatSurface（useEffect 同步 sessionId）；讀者在側欄開啟時一次性
// 取值，不訂閱、不重繪。

let currentAgentSessionId: string | null = null;

/** 唯一寫者：AgentChatSurface（把 useAgentChat 的 sessionId 同步進來）。 */
export function setCurrentAgentSession(id: string | null): void {
  currentAgentSessionId = id;
}

/** 讀者：MobileSidebar 開啟時一次性讀取；agent 面未掛載／尚未建號回 null。 */
export function getCurrentAgentSession(): string | null {
  return currentAgentSessionId;
}
