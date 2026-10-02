import type {
  AgentAudioItem,
  AgentImageItem,
  AgentTranscriptItem,
  AgentVideoItem,
} from "@/lib/agent-chat-types";
import type { HistoryEntry } from "@/lib/history-types";
import { getStoredToken, getStoredUser } from "@/lib/new-api-client";

/**
 * 助理產物（圖／影片／音樂）→ 歷史記錄。
 *
 * 本檔由 `agent-image-share.ts` 逐行複製再擴充（白名單＝新增的型別分支與欄位）：
 * 既有的「分享」路徑只認歷史 entry，而助理單圖走 biz 生成、從不寫歷史 ⇒ 主流量的
 * 作品一直分享不了。原實作只補寫圖片，且只在按下「分享」時才呼叫；這裡把同一套
 * 穩定 id + POST /api/history 的輪子擴到三種媒體，並提供 surface 自動落歷史用的
 * 純函數。
 *
 * id 規則沿用既有穩定規則（`agent-<taskId>`，無 taskId 時用 url 雜湊）：同一張圖／
 * 同一段影片重點分享或重跑＝同一條記錄（冪等 upsert），不因重新渲染而長出第二條。
 */

/** 三種可落歷史的助理媒體條目。 */
export type AgentMediaItem = AgentImageItem | AgentVideoItem | AgentAudioItem;

/** 型別守衛：把 transcript 條目收斂到三種媒體（其餘條目一律不是落歷史對象）。 */
export function isAgentMediaItem(item: AgentTranscriptItem): item is AgentMediaItem {
  return item.kind === "image" || item.kind === "video" || item.kind === "audio";
}

/** 穩定 id：`agent-<taskId>`；無 taskId 時以 url 雜湊兜底（同 url ＝ 同一條）。 */
function agentMediaId(taskId: string | undefined, url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i += 1) hash = (hash * 31 + url.charCodeAt(i)) | 0;
  return `agent-${taskId ?? `u${(hash >>> 0).toString(36)}`}`;
}

/**
 * 把一筆助理媒體條目合成為可經 POST /api/history 落庫的 HistoryEntry。
 *
 * 圖／影片／音頻各自的 url 落在對應欄位（imageUrl / videoUrl / audioUrl），
 * entryKind 與 mediaType 同步分流，歷史頁才能把三類分開顯示。
 *
 * 圖卡另帶 recipe：`workflow.imageSize` 一定要放——RerunDialog 與
 * buildHistoryRerunPlan 靠它推比例與尺寸覆寫，不放會退化成 1:1 / 1k。
 * 影片／音頻沒有配方可帶，prompt 空字串即可（normalizeHistoryEntry 只要求 id + generatedAt）。
 */
export function agentHistoryEntryForMedia(item: AgentMediaItem): HistoryEntry {
  const id = agentMediaId(item.taskId, item.url);
  const taskFields = item.taskId ? { taskId: item.taskId } : {};

  if (item.kind === "image") {
    const modelId = item.recipe?.model || "agent";
    const size = item.recipe?.size;
    return {
      id,
      prompt: item.recipe?.prompt ?? "",
      generatedAt: Date.now(),
      source: "server",
      entryKind: "image",
      modelId,
      ...taskFields,
      results: [
        {
          provider: "image_tinchak",
          modelId,
          image: null,
          imageUrl: item.url,
          mediaType: "image",
          ...taskFields,
        },
      ],
      ...(size ? { workflow: { imageSize: size } } : {}),
    };
  }

  if (item.kind === "video") {
    return {
      id,
      prompt: "",
      generatedAt: Date.now(),
      source: "server",
      entryKind: "video",
      modelId: "agent",
      ...taskFields,
      results: [
        {
          provider: "agent",
          modelId: "agent",
          image: null,
          imageUrl: null,
          videoUrl: item.url,
          mediaType: "video",
          ...taskFields,
        },
      ],
    };
  }

  return {
    id,
    prompt: "",
    generatedAt: Date.now(),
    source: "server",
    entryKind: "audio",
    modelId: "agent",
    ...taskFields,
    results: [
      {
        provider: "agent",
        modelId: "agent",
        image: null,
        imageUrl: null,
        audioUrl: item.url,
        mediaType: "audio",
        ...taskFields,
      },
    ],
  };
}

/**
 * 寫入歷史：沿用既有 POST /api/history（含 token / x-user-id 身分標頭）。
 * 抓不到 token 直接回 false——未登入不該送出裸請求，呼叫方靜默處理即可。
 */
export async function saveAgentMediaToHistory(entry: HistoryEntry): Promise<boolean> {
  const token = getStoredToken();
  if (!token) return false;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  const user = getStoredUser();
  if (user?.id) headers["x-user-id"] = String(user.id);
  try {
    const res = await fetch("/api/history", { method: "POST", headers, body: JSON.stringify(entry) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 目前 transcript 裡所有媒體條目的 id（surface 拿它在會話基準點灌入已處理集合）。 */
export function agentMediaItemIds(items: AgentTranscriptItem[]): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (isAgentMediaItem(item)) ids.push(item.id);
  }
  return ids;
}

/**
 * 同一媒體條目在同一 session 內最多補寫次數；用盡即放棄（避免失敗風暴）。
 * 以 transcript 條目 id 為鍵——與 `agentMediaItemIds` / processed 集合同源。
 */
export const AGENT_MEDIA_HISTORY_MAX_ATTEMPTS = 3;

/** 一筆待補寫的媒體：itemId 是 transcript 條目 id（去重／重試鍵），entry 是落庫內容。 */
export type AgentMediaHistoryWrite = {
  itemId: string;
  entry: HistoryEntry;
};

/** 純函數輸出：本輪要送的條目 + 套用後應併入 processed 的 id 全集。 */
export type AgentMediaHistoryPlan = {
  writes: AgentMediaHistoryWrite[];
  /**
   * 套用後應併入 processed 的 id 全集＝
   * `processedIds` ∪ 本輪送出中的 id（送出前佔位，成功即定案）∪ 重試用盡判為放棄的 id。
   * effect 把它整包換進 processed ref；失敗且未達上限者再從中撤回（見 surface）。
   */
  nextProcessedIds: string[];
};

const EMPTY_ID_SET: ReadonlySet<string> = new Set();
const EMPTY_ATTEMPTS: ReadonlyMap<string, number> = new Map();

/**
 * 決定這一輪要補寫哪些媒體（純函數，可直測）。
 *
 * 逐條掃 items，過三道閘：
 *  - 非媒體、已在 processedIds、同輪同 id 重複 → 跳過；
 *  - 重試次數已達 `AGENT_MEDIA_HISTORY_MAX_ATTEMPTS` → 判為放棄，併入 nextProcessedIds 不再挑；
 *  - 已在 inFlightIds（同 id 已有未回請求）→ 本輪跳過，避免並發重複 POST。
 * 通過者才進 writes，並即時併入 nextProcessedIds（送出前佔位；失敗由呼叫方撤回）。
 *
 * 純函數不碰網路、不改入參，effect 只負責呼叫與套用結果。
 */
export function planAgentMediaHistoryWrites(
  items: AgentTranscriptItem[],
  processedIds: ReadonlySet<string>,
  inFlightIds: ReadonlySet<string>,
  attempts: ReadonlyMap<string, number>,
): AgentMediaHistoryPlan {
  const nextProcessedIds = new Set(processedIds);
  const writes: AgentMediaHistoryWrite[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!isAgentMediaItem(item)) continue;
    const itemId = item.id;
    if (processedIds.has(itemId) || seen.has(itemId)) continue;
    seen.add(itemId);
    // 重試用盡＝明確不可救的失敗：標記放棄（併入 processed），之後不再挑，也不影響其他條目。
    if ((attempts.get(itemId) ?? 0) >= AGENT_MEDIA_HISTORY_MAX_ATTEMPTS) {
      nextProcessedIds.add(itemId);
      continue;
    }
    // 同一 id 已有未回請求 → 本輪不重複挑出。
    if (inFlightIds.has(itemId)) continue;
    writes.push({ itemId, entry: agentHistoryEntryForMedia(item) });
    nextProcessedIds.add(itemId);
  }
  return { writes, nextProcessedIds: [...nextProcessedIds] };
}

/**
 * 給定 items 與「已處理 id 集合」→ 回傳這一輪要補寫歷史的條目（純函數，可直測）。
 *
 * 同一 id 在同一輪只出一次；已在集合裡的一律跳過（冪等靠穩定 id，表面靠這個集合
 * 去重，避免每次 state.items 更新都對同一條媒體重打一次 POST）。
 * 此為 `planAgentMediaHistoryWrites` 的無 in-flight／無重試預算簡化版（單一輪子，不重複邏輯）。
 */
export function pendingAgentMediaHistoryEntries(
  items: AgentTranscriptItem[],
  processed: ReadonlySet<string>,
): HistoryEntry[] {
  return planAgentMediaHistoryWrites(items, processed, EMPTY_ID_SET, EMPTY_ATTEMPTS).writes.map(
    (write) => write.entry,
  );
}