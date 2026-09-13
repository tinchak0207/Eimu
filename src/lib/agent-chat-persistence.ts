// Agent 聊天会话持久化：把「未结束的对话」落在 localStorage，供下次进入时恢复。
//
// 为什么存 localStorage：
//   - 网关没有 session GET / list 端点，前端手上唯一能跨刷新持有的会话凭据
//     就是 sessionId（DELETE 之外没有任何读路径）。
//   - 存活线 24 小时（2026-08-29 起）：网关闲置 30 分钟只回收内存态，DB row
//     （sessions.db）保留 7 天、opencode 会话不再被 idle reaper 删除——空闲会话
//     重开 SSE 时经 DB 懒恢复照常铸票、回放历史。因此存档给满 24h 保存线，
//     覆盖暴君要求的「至少保存 24 小时」。
//
// 防御纪律（隐私模式 / 坏数据一律当「没有存档」，绝不 throw）：
//   - localStorage 在隐私模式或禁用环境下 getItem/setItem 会抛异常 → 吞掉。
//   - JSON 解析失败 → 吞掉。
//   - schema 不符（版本号不对、sessionId 不是字符串、items 不是数组…）→ 吞掉。
//   - 超量截断：只留最近 MAX_PERSISTED_ITEMS 条，避免 5MB 上限被撑爆；
//     image 条目只留 url / costCoins / seq / id 这类小字段，绝不落 base64。
//
// 本模块是纯函数：storage 由调用方注入（浏览器传 window.localStorage，
// 测试传内存实现），便于 node 环境下直接测。

import type { AgentTranscriptItem } from "./agent-chat-types";

export const AGENT_CHAT_STORAGE_KEY = "agent-chat-session-v1";
export const AGENT_CHAT_STORAGE_VERSION = 1;

/**
 * 存活时限 24 小时（2026-08-29）：网关侧 DB 懒恢复 + opencode 历史保留后，
 * 超过 30 分钟的存档也能恢复，没必要再跟着内存回收线走。过期存档直接当
 * 「没有存档」，不提示恢复。
 */
export const AGENT_CHAT_RECLAIM_MS = 24 * 60 * 60 * 1000;

/** 最多保留最近多少条 transcript 条目，防止 localStorage 5MB 被撑爆。 */
export const MAX_PERSISTED_ITEMS = 80;

/** 持久化快照的最小可用子集（load 与 save 共用的书写契约）。 */
export interface PersistedAgentChat {
  version: number;
  sessionId: string;
  lastEventId: number;
  savedAt: number;
  items: AgentTranscriptItem[];
}

/** localStorage 的最小接口形状，测试里用假实现替换。 */
export interface AgentStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// ─────────────────────────── 数据清洗

const ITEM_KINDS = new Set(["user", "assistant", "tool", "image", "video", "audio", "notice", "subagent_result"]);

/**
 * 从 transcript 里挑出可持久化的条目，并对 image 条目做「瘦身」：
 * 只留 id/kind/seq/url/costCoins，丢掉 taskId 这类可能很大的字段。
 * 目的就是不要往 localStorage 塞任何可能撑爆配额字节数的大字段。
 */
export function sanitizeItemsForStorage(items: AgentTranscriptItem[]): AgentTranscriptItem[] {
  const out: AgentTranscriptItem[] = [];
  for (const it of items) {
    if (it == null || typeof it !== "object") continue;
    if (it.kind === "image") {
      // 只留小字段；不复制 taskId 之类可能携带大串的字段。
      out.push({
        kind: "image",
        id: it.id,
        seq: it.seq,
        url: it.url,
        costCoins: it.costCoins,
      });
      continue;
    }
    if (it.kind === "video") {
      // 与 image 同法瘦身：留小字段，不复制 taskId。
      out.push({
        kind: "video",
        id: it.id,
        seq: it.seq,
        url: it.url,
        costCoins: it.costCoins,
        mediaKind: it.mediaKind,
      });
      continue;
    }
    if (it.kind === "audio") {
      // 与 image/video 同法瘦身：留小字段，不复制 taskId。
      out.push({
        kind: "audio",
        id: it.id,
        seq: it.seq,
        url: it.url,
        costCoins: it.costCoins,
        mediaKind: it.mediaKind,
      });
      continue;
    }
    if (it.kind === "director") {
      // 導演卡不入存檔（2026-09-02 片5）：兩張 base64 SVG 可達近百 KB 會撐爆
      // localStorage 配額，且 ITEM_KINDS 白名單不含 director——落存檔會讓
      // isValidItemsArray 判整份快照無效、回放全滅。卡片隨會話存活（spec §5
      // 片5「別過度工程」條款），刷新後由 agent 重新規劃即可。
      continue;
    }
    if (it.kind === "subagent") {
      // 子代理运行卡不入存檔：它只在回合进行中有意义（turn.done 时 reducer
      // 已转存成 subagent_result 产出卡），刷新后重放一张「运行中」的僵尸卡
      // 就是谎报；且它不在 ITEM_KINDS 白名单里，落存檔会让整份快照判无效。
      continue;
    }
    out.push(it);
  }
  return out;
}

/** 截到最近 MAX_PERSISTED_ITEMS 条：留在时效内的旧对话没必要准备基翻页，80 条够看。 */
export function truncateItems(items: AgentTranscriptItem[]): AgentTranscriptItem[] {
  if (items.length <= MAX_PERSISTED_ITEMS) return items;
  return items.slice(items.length - MAX_PERSISTED_ITEMS);
}

export function isPersistedExpired(savedAt: number, now: number = Date.now()): boolean {
  return now - savedAt > AGENT_CHAT_RECLAIM_MS;
}

function isValidItemsArray(v: unknown): v is AgentTranscriptItem[] {
  if (!Array.isArray(v)) return false;
  for (const it of v) {
    if (it == null || typeof it !== "object") return false;
    const d = it as Record<string, unknown>;
    if (typeof d.id !== "string" || typeof d.kind !== "string" || !ITEM_KINDS.has(d.kind)) return false;
    if (typeof d.seq !== "number") return false;
  }
  return true;
}

function isPersistedSnapshot(v: unknown): v is PersistedAgentChat {
  if (v == null || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.version === "number" &&
    d.version === AGENT_CHAT_STORAGE_VERSION &&
    typeof d.sessionId === "string" &&
    d.sessionId.length > 0 &&
    typeof d.lastEventId === "number" &&
    Number.isFinite(d.lastEventId) &&
    d.lastEventId >= 0 &&
    typeof d.savedAt === "number" &&
    Number.isFinite(d.savedAt) &&
    isValidItemsArray(d.items)
  );
}

// ─────────────────────────── 读写

/** 读存档。任何异常/坏格式/过期一律回 null，绝不 throw。 */
export function loadPersistedSnapshot(storage: AgentStorageLike, now: number = Date.now()): PersistedAgentChat | null {
  let raw: string | null = null;
  try {
    raw = storage.getItem(AGENT_CHAT_STORAGE_KEY);
  } catch {
    // 隐私模式 / 禁用存储 / 拦截器抛错：一律当没有存档。
    return null;
  }
  if (raw == null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // JSON 坏了（被截断 / 被别的手动覆盖）：宁可当没有存档，绝不 throw。
    return null;
  }
  if (!isPersistedSnapshot(parsed)) return null;
  if (isPersistedExpired(parsed.savedAt, now)) return null;

  return {
    version: parsed.version,
    sessionId: parsed.sessionId,
    lastEventId: parsed.lastEventId,
    savedAt: parsed.savedAt,
    items: truncateItems(sanitizeItemsForStorage(parsed.items)),
  };
}

/** 写入快照：失败（隐私模式 / 配额爆）返回 false，绝不 throw。 */
export function savePersistedSnapshot(
  storage: AgentStorageLike,
  snapshot: Omit<PersistedAgentChat, "version">,
  now: number = Date.now(),
): boolean {
  const slimmed: Omit<PersistedAgentChat, "version"> = {
    sessionId: snapshot.sessionId,
    lastEventId: snapshot.lastEventId,
    savedAt: now,
    items: truncateItems(sanitizeItemsForStorage(snapshot.items)),
  };
  try {
    storage.setItem(AGENT_CHAT_STORAGE_KEY, JSON.stringify({ version: AGENT_CHAT_STORAGE_VERSION, ...slimmed }));
    return true;
  } catch {
    return false;
  }
}

/** 删除存档；失败也不 throw（幂等清除），返回是否成功。 */
export function clearPersistedSnapshot(storage: AgentStorageLike): boolean {
  try {
    storage.removeItem(AGENT_CHAT_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────── 浏览器默认绑定（hook 用它，测试用注入版）

function browserStorage(): AgentStorageLike | null {
  if (typeof window === "undefined") return null;
  return window.localStorage ?? null;
}

/** 读浏览器里未过期的存档；没有 / 隐私模式 / 坏数据一律回 null。 */
export function loadPersisted(now: number = Date.now()): PersistedAgentChat | null {
  const storage = browserStorage();
  if (!storage) return null;
  return loadPersistedSnapshot(storage, now);
}

/** 写浏览器存档；失败回 false，绝不 throw。 */
export function savePersisted(snapshot: Omit<PersistedAgentChat, "version">): boolean {
  const storage = browserStorage();
  if (!storage) return false;
  return savePersistedSnapshot(storage, snapshot);
}

/** 清掉浏览器存档；失败也不 throw。 */
export function clearPersisted(): boolean {
  const storage = browserStorage();
  if (!storage) return false;
  return clearPersistedSnapshot(storage);
}
