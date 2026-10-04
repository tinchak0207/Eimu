import type {
  AgentAudioItem,
  AgentImageItem,
  AgentTranscriptItem,
  AgentVideoItem,
} from "@/lib/agent-chat-types";
import type { HistoryEntry } from "@/lib/history-types";
import { getStoredToken, getStoredUser } from "@/lib/new-api-client";

/**
 * 助理产物（图／影片／音乐）→ 历史记录。
 *
 * 本档由 `agent-image-share.ts` 逐行复制再扩充（白名单＝新增的型别分支与栏位）：
 * 既有的「分享」路径只认历史 entry，而助理单图走 biz 生成、从不写历史 ⇒ 主流量的
 * 作品一直分享不了。原实作只补写图片，且只在按下「分享」时才呼叫；这里把同一套
 * 稳定 id + POST /api/history 的轮子扩到三种媒体，并提供 surface 自动落历史用的
 * 纯函数。
 *
 * id 规则沿用既有稳定规则（`agent-<taskId>`，无 taskId 时用 url 杂凑）：同一张图／
 * 同一段影片重点分享或重跑＝同一条记录（幂等 upsert），不因重新渲染而长出第二条。
 */

/** 三种可落历史的助理媒体条目。 */
export type AgentMediaItem = AgentImageItem | AgentVideoItem | AgentAudioItem;

/** 型别守卫：把 transcript 条目收敛到三种媒体（其余条目一律不是落历史对象）。 */
export function isAgentMediaItem(item: AgentTranscriptItem): item is AgentMediaItem {
  return item.kind === "image" || item.kind === "video" || item.kind === "audio";
}

/** 稳定 id：`agent-<taskId>`；无 taskId 时以 url 杂凑兜底（同 url ＝ 同一条）。 */
function agentMediaId(taskId: string | undefined, url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i += 1) hash = (hash * 31 + url.charCodeAt(i)) | 0;
  return `agent-${taskId ?? `u${(hash >>> 0).toString(36)}`}`;
}

/**
 * 把一笔助理媒体条目合成为可经 POST /api/history 落库的 HistoryEntry。
 *
 * 图／影片／音频各自的 url 落在对应栏位（imageUrl / videoUrl / audioUrl），
 * entryKind 与 mediaType 同步分流，历史页才能把三类分开显示。
 *
 * 图卡另带 recipe：`workflow.imageSize` 一定要放——RerunDialog 与
 * buildHistoryRerunPlan 靠它推比例与尺寸覆写，不放会退化成 1:1 / 1k。
 * 影片／音频没有配方可带，prompt 空字串即可（normalizeHistoryEntry 只要求 id + generatedAt）。
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
 * 写入历史：沿用既有 POST /api/history（含 token / x-user-id 身分标头）。
 * 抓不到 token 直接回 false——未登入不该送出裸请求，呼叫方静默处理即可。
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

/** 目前 transcript 里所有媒体条目的 id（surface 拿它在会话基准点灌入已处理集合）。 */
export function agentMediaItemIds(items: AgentTranscriptItem[]): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (isAgentMediaItem(item)) ids.push(item.id);
  }
  return ids;
}

/**
 * 同一媒体条目在同一 session 内最多补写次数；用尽即放弃（避免失败风暴）。
 * 以 transcript 条目 id 为键——与 `agentMediaItemIds` / processed 集合同源。
 */
export const AGENT_MEDIA_HISTORY_MAX_ATTEMPTS = 3;

/** 一笔待补写的媒体：itemId 是 transcript 条目 id（去重／重试键），entry 是落库内容。 */
export type AgentMediaHistoryWrite = {
  itemId: string;
  entry: HistoryEntry;
};

/** 纯函数输出：本轮要送的条目 + 套用后应并入 processed 的 id 全集。 */
export type AgentMediaHistoryPlan = {
  writes: AgentMediaHistoryWrite[];
  /**
   * 套用后应并入 processed 的 id 全集＝
   * `processedIds` ∪ 本轮送出中的 id（送出前占位，成功即定案）∪ 重试用尽判为放弃的 id。
   * effect 把它整包换进 processed ref；失败且未达上限者再从中撤回（见 surface）。
   */
  nextProcessedIds: string[];
};

const EMPTY_ID_SET: ReadonlySet<string> = new Set();
const EMPTY_ATTEMPTS: ReadonlyMap<string, number> = new Map();

/**
 * 决定这一轮要补写哪些媒体（纯函数，可直测）。
 *
 * 逐条扫 items，过三道闸：
 *  - 非媒体、已在 processedIds、同轮同 id 重复 → 跳过；
 *  - 重试次数已达 `AGENT_MEDIA_HISTORY_MAX_ATTEMPTS` → 判为放弃，并入 nextProcessedIds 不再挑；
 *  - 已在 inFlightIds（同 id 已有未回请求）→ 本轮跳过，避免并发重复 POST。
 * 通过者才进 writes，并即时并入 nextProcessedIds（送出前占位；失败由呼叫方撤回）。
 *
 * 纯函数不碰网路、不改入参，effect 只负责呼叫与套用结果。
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
    // 重试用尽＝明确不可救的失败：标记放弃（并入 processed），之后不再挑，也不影响其他条目。
    if ((attempts.get(itemId) ?? 0) >= AGENT_MEDIA_HISTORY_MAX_ATTEMPTS) {
      nextProcessedIds.add(itemId);
      continue;
    }
    // 同一 id 已有未回请求 → 本轮不重复挑出。
    if (inFlightIds.has(itemId)) continue;
    writes.push({ itemId, entry: agentHistoryEntryForMedia(item) });
    nextProcessedIds.add(itemId);
  }
  return { writes, nextProcessedIds: [...nextProcessedIds] };
}

/**
 * 给定 items 与「已处理 id 集合」→ 回传这一轮要补写历史的条目（纯函数，可直测）。
 *
 * 同一 id 在同一轮只出一次；已在集合里的一律跳过（幂等靠稳定 id，表面靠这个集合
 * 去重，避免每次 state.items 更新都对同一条媒体重打一次 POST）。
 * 此为 `planAgentMediaHistoryWrites` 的无 in-flight／无重试预算简化版（单一轮子，不重复逻辑）。
 */
export function pendingAgentMediaHistoryEntries(
  items: AgentTranscriptItem[],
  processed: ReadonlySet<string>,
): HistoryEntry[] {
  return planAgentMediaHistoryWrites(items, processed, EMPTY_ID_SET, EMPTY_ATTEMPTS).writes.map(
    (write) => write.entry,
  );
}