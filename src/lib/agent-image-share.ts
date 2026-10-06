import type { AgentImageItem } from "@/lib/agent-chat-types";
import type { HistoryEntry } from "@/lib/history-types";
import { getStoredToken, getStoredUser } from "@/lib/new-api-client";
import { firstShareableIndex } from "@/lib/share-remix";
import { PROVIDER_KEY } from "@/lib/provider-key";

/**
 * 助理出图 → 历史记录（分享的前置）。
 *
 * 分享只认历史 entry（/api/share 按 entryId 在本人历史里查），而助理单图走 biz 生成、
 * 从不写历史 ⇒ 主流量面的作品一直分享不了。这里以稳定 id（agent-<taskId>，无 taskId
 * 时用 url 杂凑）经既有 POST /api/history 补写：同一张图重点分享＝同一条记录（幂等），
 * 顺带让助理作品出现在历史页。
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
    results: [{ provider: PROVIDER_KEY, modelId, image: null, imageUrl: item.url, ...(item.taskId ? { taskId: item.taskId } : {}) }],
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
 * 站内读写路由共用的身分标头（token + x-user-id 成对）。
 * 与 ShareDialog 原 `authHeaders()` 逐字同形；分享（/api/share）与媒体同源代理
 * （/api/media-download）都走这一份，不各拼一套（禁造轮子）。回传的物件可安全
 * 直接当 HeadersInit 用。
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
 * 从媒体 URL 推副档名（图片卡的「改图 → 附件」档名用）：只认路径尾段、
 * 先剥 query/fragment；推不到就落 png（助理出图绝大多数是 png）。
 * 纯函式，值域独立于呼叫端的 blob.type。
 */
export function imageExtensionFromUrl(url: string): string {
  const path = (url.split("#")[0] ?? "").split("?")[0] ?? "";
  const match = /\.([A-Za-z0-9]{2,5})$/.exec(path);
  return match ? match[1].toLowerCase() : "png";
}

/** 建立（或取回）分享连结的结果：成功带 url（分享钮只需它）；失败带人话讯息。 */
export type ShareLinkResult =
  | { ok: true; url: string; shareId: string; hidePrompt: boolean }
  | { ok: false; message: string };

export interface CreateShareLinkOptions {
  /** 分享哪一项结果；省略时取第一个可分享项（图片卡固定 results[0]）。 */
  resultIndex?: number;
  /** 覆写「未登入」讯息（预设沿用 ShareDialog 原字串）。 */
  notSignedInMessage?: string;
}

/**
 * 建立／取回一件作品的公开分享连结（纯函式层，唯一真源）。
 *
 * 请求形状与回应契约照 /api/share：`POST { entryId, resultIndex, hidePrompt:false }`
 * ＋站内身分标头，回应 `{ success, data:{ shareId, url, hidePrompt } }`。
 * 回传 `{ok:true,url,...}`｜`{ok:false,message}`——ShareDialog 与媒体卡共用同一份
 * 讯息判准，不各写一套错误文案（原 ShareDialog 的四条文案逐字保留）。
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
