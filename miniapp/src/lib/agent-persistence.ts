// Agent 聊天按账号缓存：本地只做加速，服务端会话目录与全量历史才是真源。
//
// 真源与防御纪律照搬 src/lib/agent-chat-persistence.ts（262 行）：
//   - localStorage（小程序为 Taro storage）在隐私模式 / 配额满 / 禁用环境下
//     getItem/setItem 会抛异常 → 吞掉，一律当「没有存档」，绝不 throw。
//   - JSON 解析失败 → 吞掉。
//   - schema 不符（版本号不对、sessionId 不是字串、items 不是数组…）→ 吞掉。
//   - 超量截断：只留最近 MAX_PERSISTED_ITEMS 条；媒体条目只留 url/seq/id
//     这类小字段，绝不落 base64。
//   - 账号隔离：key 带 `:user:<ownerId>` 后缀，换账号读不到上一账号的快照。
//
// 本模块纯函数部分（snapshot 读写、清洗、截断）由 storage 注入，
// 浏览器/Taro 绑定在文件底部；node 环境可直接用内存实现测。

import Taro from '@tarojs/taro'
import type { AgentItem } from '../components/agent-chat/types'
import { getUserId } from './storage'

export const AGENT_CHAT_STORAGE_KEY = 'agent-chat-session-v1'
export const AGENT_CHAT_STORAGE_VERSION = 1

/** 存活时限 24 小时（与网页端一致）：过期存档直接当「没有存档」。 */
export const AGENT_CHAT_RECLAIM_MS = 24 * 60 * 60 * 1000

/** 最多保留最近多少条 transcript 条目，防止小程序 storage 10MB 被撑爆。 */
export const MAX_PERSISTED_ITEMS = 80

/** 会话标题的本地别名（服务端尚无重命名端点时的兜底，账号隔离）。 */
export const AGENT_CHAT_TITLE_KEY = 'agent-session-title-v1'

export interface PersistedAgentChat {
  version: number
  sessionId: string
  lastEventId: number
  savedAt: number
  items: AgentItem[]
}

/** 写入入参：savedAt 由写入方盖章（调用方不必自备时钟）。 */
export type PersistedAgentChatInput = Omit<PersistedAgentChat, 'version' | 'savedAt'>

/** storage 的最小接口形状：Taro 与内存实现都可注入。 */
export interface AgentStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

// ─────────────────────────── 数据清洗

const ITEM_KINDS = new Set([
  'user',
  'assistant',
  'tool',
  'image',
  'video',
  'audio',
  'notice',
  'subagent_result',
])

/**
 * 从 transcript 里挑出可持久化的条目，并对媒体条目做「瘦身」。
 * 目的：不要往本地 storage 塞任何可能撑爆配额的大字段（base64 / taskId）。
 */
export function sanitizeItemsForStorage(items: AgentItem[]): AgentItem[] {
  const out: AgentItem[] = []
  for (const it of items) {
    if (it == null || typeof it !== 'object') continue
    if (it.kind === 'image') {
      out.push({ kind: 'image', id: it.id, seq: it.seq, url: it.url, costCoins: it.costCoins })
      continue
    }
    if (it.kind === 'video') {
      out.push({
        kind: 'video',
        id: it.id,
        seq: it.seq,
        url: it.url,
        costCoins: it.costCoins,
        mediaKind: it.mediaKind,
      })
      continue
    }
    if (it.kind === 'audio') {
      out.push({
        kind: 'audio',
        id: it.id,
        seq: it.seq,
        url: it.url,
        costCoins: it.costCoins,
        mediaKind: it.mediaKind,
        title: it.title,
        cover: it.cover,
        lyricStatus: it.lyricStatus,
      })
      continue
    }
    if (it.kind === 'director') {
      // 导演卡带两张 base64 SVG，会撑爆本地配额；且不在白名单内，
      // 落存档会让整份快照判无效（与网页端同一条纪律）。
      continue
    }
    if (it.kind === 'subagent') {
      // 运行卡只在回合中有意义；刷新后重放一张「运行中」的僵尸卡就是谎报。
      continue
    }
    if (it.kind === 'plan') {
      // 计划卡是回合内视图，不入存档（网页端 ITEM_KINDS 同样不含 plan）。
      continue
    }
    out.push(it)
  }
  return out
}

/** 截到最近 MAX_PERSISTED_ITEMS 条。 */
export function truncateItems(items: AgentItem[]): AgentItem[] {
  if (items.length <= MAX_PERSISTED_ITEMS) return items
  return items.slice(items.length - MAX_PERSISTED_ITEMS)
}

export function isPersistedExpired(savedAt: number, now: number = Date.now()): boolean {
  return now - savedAt > AGENT_CHAT_RECLAIM_MS
}

function isValidItemsArray(v: unknown): v is AgentItem[] {
  if (!Array.isArray(v)) return false
  for (const it of v) {
    if (it == null || typeof it !== 'object') return false
    const d = it as Record<string, unknown>
    if (typeof d.id !== 'string' || typeof d.kind !== 'string' || !ITEM_KINDS.has(d.kind)) return false
    // 小程序 AgentItem 只有媒体条目声明了 seq；媒体缺 seq 会让「第 N 张」失序。
    if ((d.kind === 'image' || d.kind === 'video' || d.kind === 'audio') && typeof d.seq !== 'number') {
      return false
    }
  }
  return true
}

function isPersistedSnapshot(v: unknown): v is PersistedAgentChat {
  if (v == null || typeof v !== 'object') return false
  const d = v as Record<string, unknown>
  return (
    typeof d.version === 'number' &&
    d.version === AGENT_CHAT_STORAGE_VERSION &&
    typeof d.sessionId === 'string' &&
    d.sessionId.length > 0 &&
    typeof d.lastEventId === 'number' &&
    Number.isFinite(d.lastEventId) &&
    d.lastEventId >= 0 &&
    typeof d.savedAt === 'number' &&
    Number.isFinite(d.savedAt) &&
    isValidItemsArray(d.items)
  )
}

// ─────────────────────────── 读写

/** 读存档。任何异常/坏格式/过期一律回 null，绝不 throw。 */
export function loadPersistedSnapshot(
  storage: AgentStorageLike,
  now: number = Date.now(),
): PersistedAgentChat | null {
  let raw: string | null = null
  try {
    raw = storage.getItem(AGENT_CHAT_STORAGE_KEY)
  } catch {
    return null
  }
  if (raw == null || raw === '') return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // JSON 坏了（被截断 / 被手动覆盖）：宁可当没有存档，绝不 throw。
    return null
  }
  if (!isPersistedSnapshot(parsed)) return null
  if (isPersistedExpired(parsed.savedAt, now)) return null

  return {
    version: parsed.version,
    sessionId: parsed.sessionId,
    lastEventId: parsed.lastEventId,
    savedAt: parsed.savedAt,
    items: truncateItems(sanitizeItemsForStorage(parsed.items)),
  }
}

/** 写入快照：失败（隐私模式 / 配额爆）返回 false，绝不 throw。 */
export function savePersistedSnapshot(
  storage: AgentStorageLike,
  snapshot: PersistedAgentChatInput,
  now: number = Date.now(),
): boolean {
  const slimmed: PersistedAgentChatInput = {
    sessionId: snapshot.sessionId,
    lastEventId: snapshot.lastEventId,
    items: truncateItems(sanitizeItemsForStorage(snapshot.items)),
  }
  try {
    storage.setItem(
      AGENT_CHAT_STORAGE_KEY,
      JSON.stringify({ version: AGENT_CHAT_STORAGE_VERSION, savedAt: now, ...slimmed }),
    )
    return true
  } catch {
    return false
  }
}

/** 删除存档；失败也不 throw（幂等清除）。 */
export function clearPersistedSnapshot(storage: AgentStorageLike): boolean {
  try {
    storage.removeItem(AGENT_CHAT_STORAGE_KEY)
    return true
  } catch {
    return false
  }
}

// ─────────────────────────── Taro 默认绑定（账号隔离）

/** Taro storage → 注入接口。缺失值返回 ''，这里统一归一成 null。 */
const taroStorage: AgentStorageLike = {
  getItem(key: string): string | null {
    const value = Taro.getStorageSync(key)
    return typeof value === 'string' && value.length > 0 ? value : null
  },
  setItem(key: string, value: string): void {
    Taro.setStorageSync(key, value)
  },
  removeItem(key: string): void {
    Taro.removeStorageSync(key)
  },
}

function accountStorage(storage: AgentStorageLike, ownerId: number): AgentStorageLike {
  const key = `${AGENT_CHAT_STORAGE_KEY}:user:${ownerId}`
  return {
    getItem: () => storage.getItem(key),
    setItem: (_key, value) => storage.setItem(key, value),
    removeItem: () => storage.removeItem(key),
  }
}

function storedOwner(): number | null {
  try {
    return getUserId()
  } catch {
    return null
  }
}

/** 读当前账号未过期的存档；没有 / 未登录 / 坏数据一律回 null。 */
export function loadPersisted(now: number = Date.now(), ownerId: number | null = storedOwner()): PersistedAgentChat | null {
  if (ownerId === null) return null
  return loadPersistedSnapshot(accountStorage(taroStorage, ownerId), now)
}

/** 写当前账号存档；失败回 false，绝不 throw。 */
export function savePersisted(
  snapshot: PersistedAgentChatInput,
  ownerId: number | null = storedOwner(),
): boolean {
  if (ownerId === null) return false
  return savePersistedSnapshot(accountStorage(taroStorage, ownerId), snapshot)
}

/** 清当前账号存档；失败也不 throw。 */
export function clearPersisted(ownerId: number | null = storedOwner()): boolean {
  if (ownerId === null) return false
  return clearPersistedSnapshot(accountStorage(taroStorage, ownerId))
}

// ─────────────────────────── 会话标题本地别名
//
// 服务端目前没有重命名端点（站点代理只有 GET/DELETE，网关无 PATCH）。
// renameSession 先尝试 PATCH，端点不存在时落到这里做账号级别名；
// 服务端真源不变，列表合并别名只为显示。读写同样绝不 throw。

/** 已绑定单个 key 的 storage（标题别名表用）。 */
interface KeyedStorage {
  getItem(): string | null
  setItem(value: string): void
  removeItem(): void
}

function titleStorage(ownerId: number): KeyedStorage {
  const key = `${AGENT_CHAT_TITLE_KEY}:user:${ownerId}`
  return {
    getItem: () => taroStorage.getItem(key),
    setItem: (value) => taroStorage.setItem(key, value),
    removeItem: () => taroStorage.removeItem(key),
  }
}

/** 读当前账号的会话标题别名表（坏数据当空表）。 */
export function loadSessionTitleOverrides(ownerId: number | null = storedOwner()): Record<string, string> {
  if (ownerId === null) return {}
  let raw: string | null = null
  try {
    raw = titleStorage(ownerId).getItem()
  } catch {
    return {}
  }
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim().length > 0) out[key] = value.trim()
    }
    return out
  } catch {
    return {}
  }
}

/** 写一条标题别名（空标题＝删除该条）。失败静默。 */
export function saveSessionTitleOverride(
  sessionId: string,
  title: string,
  ownerId: number | null = storedOwner(),
): void {
  if (ownerId === null || !sessionId) return
  const next = loadSessionTitleOverrides(ownerId)
  const trimmed = title.trim()
  if (trimmed.length === 0) delete next[sessionId]
  else next[sessionId] = trimmed
  try {
    if (Object.keys(next).length === 0) titleStorage(ownerId).removeItem()
    else titleStorage(ownerId).setItem(JSON.stringify(next))
  } catch {
    // 本地别名写失败只影响显示，不挡聊天。
  }
}

/** 清掉一条标题别名（删除会话时用）。失败静默。 */
export function removeSessionTitleOverride(
  sessionId: string,
  ownerId: number | null = storedOwner(),
): void {
  saveSessionTitleOverride(sessionId, '', ownerId)
}

/** 清空当前账号全部标题别名（账号切换时用）。失败静默。 */
export function clearSessionTitleOverrides(ownerId: number | null = storedOwner()): void {
  if (ownerId === null) return
  try {
    titleStorage(ownerId).removeItem()
  } catch {
    // 同上。
  }
}
