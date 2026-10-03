import type { AgentImageItem } from "@/lib/agent-chat-types";
import type { HistoryEntry } from "@/lib/history-types";
import { getStoredToken, getStoredUser } from "@/lib/new-api-client";
import { firstShareableIndex } from "@/lib/share-remix";

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
  const headers = stationAuthHeaders();
  try {
    const res = await fetch("/api/history", { method: "POST", headers, body: JSON.stringify(entry) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 站內讀寫路由共用的身分標頭（token + x-user-id 成對）。
 * 與 ShareDialog 原 `authHeaders()` 逐字同形；分享（/api/share）與媒體同源代理
 * （/api/media-download）都走這一份，不各拼一套（禁造輪子）。回傳的物件可安全
 * 直接當 HeadersInit 用。
 */
export function stationAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getStoredToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const user = getStoredUser();
  if (user?.id) headers["x-user-id"] = String(user.id);
  return headers;
}

/**
 * 從媒體 URL 推副檔名（圖片卡的「改圖 → 附件」檔名用）：只認路徑尾段、
 * 先剝 query/fragment；推不到就落 png（助理出圖絕大多數是 png）。
 * 純函式，值域獨立於呼叫端的 blob.type。
 */
export function imageExtensionFromUrl(url: string): string {
  const path = (url.split("#")[0] ?? "").split("?")[0] ?? "";
  const match = /\.([A-Za-z0-9]{2,5})$/.exec(path);
  return match ? match[1].toLowerCase() : "png";
}

/** 建立（或取回）分享連結的結果：成功帶 url（分享鈕只需它）；失敗帶人話訊息。 */
export type ShareLinkResult =
  | { ok: true; url: string; shareId: string; hidePrompt: boolean }
  | { ok: false; message: string };

export interface CreateShareLinkOptions {
  /** 分享哪一項結果；省略時取第一個可分享項（圖片卡固定 results[0]）。 */
  resultIndex?: number;
  /** 覆寫「未登入」訊息（預設沿用 ShareDialog 原字串）。 */
  notSignedInMessage?: string;
}

/**
 * 建立／取回一件作品的公開分享連結（純函式層，唯一真源）。
 *
 * 請求形狀與回應契約照 /api/share：`POST { entryId, resultIndex, hidePrompt:false }`
 * ＋站內身分標頭，回應 `{ success, data:{ shareId, url, hidePrompt } }`。
 * 回傳 `{ok:true,url,...}`｜`{ok:false,message}`——ShareDialog 與媒體卡共用同一份
 * 訊息判準，不各寫一套錯誤文案（原 ShareDialog 的四條文案逐字保留）。
 */
export async function createShareLink(
  entry: HistoryEntry,
  options: CreateShareLinkOptions = {},
): Promise<ShareLinkResult> {
  const resultIndex = options.resultIndex ?? firstShareableIndex(entry);
  if (resultIndex < 0) return { ok: false, message: "这件作品没有可分享的图片。" };
  if (!getStoredToken()) {
    return { ok: false, message: options.notSignedInMessage ?? "请先登录后再分享。" };
  }
  try {
    const res = await fetch("/api/share", {
      method: "POST",
      headers: stationAuthHeaders(),
      body: JSON.stringify({ entryId: entry.id, resultIndex, hidePrompt: false }),
    });
    const payload = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      message?: string;
      data?: { shareId?: unknown; url?: unknown; hidePrompt?: unknown };
    };
    const shareId = typeof payload.data?.shareId === "string" ? payload.data.shareId : "";
    const url = typeof payload.data?.url === "string" ? payload.data.url : "";
    if (!res.ok || payload.success !== true || !shareId || !url) {
      return { ok: false, message: payload.message ?? "生成分享链接失败，请稍后重试。" };
    }
    return { ok: true, url, shareId, hidePrompt: payload.data?.hidePrompt === true };
  } catch {
    return { ok: false, message: "网络异常，分享链接没有生成。" };
  }
}
