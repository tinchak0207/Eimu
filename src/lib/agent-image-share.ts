import type { AgentImageItem } from "@/lib/agent-chat-types";
import type { HistoryEntry } from "@/lib/history-types";
import { getStoredToken, getStoredUser } from "@/lib/new-api-client";

/**
 * 助理出圖 → 歷史記錄（分享的前置）。
 *
 * 分享只認歷史 entry（/api/share 按 entryId 在本人歷史裡查），而助理單圖走 biz 生成、
 * 從不寫歷史 ⇒ 主流量面的作品一直分享不了。這裡以穩定 id（agent-<taskId>，無 taskId
 * 時用 url 雜湊）經既有 POST /api/history 補寫：同一張圖重點分享＝同一條記錄（冪等），
 * 順帶讓助理作品出現在歷史頁。
 */
export function agentHistoryEntry(item: AgentImageItem): HistoryEntry {
  let hash = 0;
  for (let i = 0; i < item.url.length; i += 1) hash = (hash * 31 + item.url.charCodeAt(i)) | 0;
  const id = `agent-${item.taskId ?? `u${(hash >>> 0).toString(36)}`}`;
  const modelId = item.recipe?.model || "agent";
  return {
    id,
    prompt: item.recipe?.prompt ?? "",
    generatedAt: Date.now(),
    source: "server",
    entryKind: "image",
    modelId,
    ...(item.taskId ? { taskId: item.taskId } : {}),
    results: [{ provider: "image_tinchak", modelId, image: null, imageUrl: item.url, ...(item.taskId ? { taskId: item.taskId } : {}) }],
  };
}

export async function saveAgentImageToHistory(entry: HistoryEntry): Promise<boolean> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getStoredToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const user = getStoredUser();
  if (user?.id) headers["x-user-id"] = String(user.id);
  try {
    const res = await fetch("/api/history", { method: "POST", headers, body: JSON.stringify(entry) });
    return res.ok;
  } catch {
    return false;
  }
}
