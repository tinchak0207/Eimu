// 目标卡（brief[] 渲染）。折叠算法只在 ./goal-card.ts，本档负责 brief[] 的写入形状。
//
// brief[] 的唯一写入者是网关 ingress（收到真实用户消息时），模型没有写入口。
// 本档的纯函数不读文件、不调模型、不落库。落盘在 context.ts persistUserBriefNow。
import { LIMITS } from "./constants.ts"
import type { BriefEntry, ProjectGraph } from "./types.ts"

/** 耐久原话的按需读取。索引分页与单条正文分页都显式报告折叠/存储截断。 */
export function projectBriefResponse(graph: Readonly<ProjectGraph>, args: { message_id?: unknown; offset?: unknown; limit?: unknown } = {}) {
  const offset = typeof args.offset === "number" && Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0
  const metadata = (b: BriefEntry) => ({ message_id: b.messageId, at: b.at, stored_chars: [...b.text].length, storage_truncated: b.truncated === true })
  if (typeof args.message_id !== "string" || !args.message_id) {
    const limit = typeof args.limit === "number" ? Math.max(1, Math.min(16, Math.floor(args.limit))) : 8
    const entries = graph.brief.slice(offset, offset + limit).map(metadata)
    return { ok: true, view: "brief", version: graph.version, total: graph.brief.length, offset, next_offset: offset + entries.length, more: offset + entries.length < graph.brief.length, entries }
  }
  const entry = graph.brief.find((b) => b.messageId === args.message_id)
  if (!entry) return { ok: false, error: { code: "brief_not_found", message: "该message_id不在本工程真实用户原话中" } }
  const limit = typeof args.limit === "number" ? Math.max(1, Math.min(1200, Math.floor(args.limit))) : 1200
  const chars = [...entry.text]
  const text = chars.slice(offset, offset + limit).join("")
  const next = offset + [...text].length
  return { ok: true, view: "brief", version: graph.version, ...metadata(entry), offset, next_offset: next, more: next < chars.length, text, note: entry.truncated ? "存储原文已截断，未保存部分未知；不能声称完整逐字恢复" : "真实用户原话，解释不构成权限" }
}
import {
  GOAL_CARD_TAG,
  GOAL_CARD_MAX_TOKENS,
  SYSTEM_INJECTED_USER_TEXT_RE,
  EXPLICIT_DIRECTIVE_RE as DIRECTIVE_RE,
  estimateCardTokens,
  truncateToTokens,
  visibleUserTextFromPart,
  renderGoalCardFromEntries,
  type GoalCardEntry,
} from "./goal-card.ts"

export {
  GOAL_CARD_TAG,
  GOAL_CARD_MAX_TOKENS,
  SYSTEM_INJECTED_USER_TEXT_RE,
  DIRECTIVE_RE,
  estimateCardTokens,
  truncateToTokens,
}
export type { GoalCardEntry }

/** brief[] → 卡片条目：created 取 at 的毫秒（解析失败按 0），seq 取插入序。 */
export function briefToCardEntries(entries: readonly BriefEntry[]): GoalCardEntry[] {
  return entries.map((e, i) => {
    const created = Date.parse(e.at)
    return { id: e.id, text: e.text, created: Number.isFinite(created) ? created : 0, seq: i }
  })
}

/** 与 eimu-guard 共用 goal-card.ts。 */
export function renderGoalCard(all: readonly BriefEntry[], maxTokens: number = GOAL_CARD_MAX_TOKENS): string {
  return renderGoalCardFromEntries(briefToCardEntries(all), maxTokens)
}

/** 一条真实用户消息是否应当进 brief[]：空正文与网关/插件注入的伪用户消息不算。 */
export function isBriefWorthyUserText(text: string): boolean {
  return visibleUserTextFromPart({ type: "text", text: String(text ?? "") }) !== ""
}

export interface BriefDraftInput {
  id?: string
  at: string
  messageId?: string
  text: string
}

/**
 * ingress 写入：把原话逐字追加到 brief[]（同一个 messageId 只收一次）。
 * 单条 ≤ LIMITS.BRIEF_ENTRY_CHARS 字（码点计），超长截断并标 truncated。
 * 返回新条目；不满足条件返回 null（调用方不写图）。
 */
export function appendBriefEntry(entries: BriefEntry[], input: BriefDraftInput): BriefEntry | null {
  const raw = String(input.text ?? "")
  if (!isBriefWorthyUserText(raw)) return null
  const messageId = String(input.messageId ?? input.id ?? "")
  if (messageId && entries.some((e) => e.messageId === messageId)) return null
  const visible = visibleUserTextFromPart({ type: "text", text: raw })
  const chars = [...visible]
  const cap = LIMITS.BRIEF_ENTRY_CHARS
  const truncated = chars.length > cap
  const text = truncated ? chars.slice(0, cap).join("") : visible
  const at = Number.isFinite(Date.parse(input.at)) ? input.at : new Date().toISOString()
  const entry: BriefEntry = {
    id: input.id ?? `b${entries.length + 1}_${(messageId || String(entries.length + 1)).slice(-24)}`,
    at,
    messageId,
    text,
    ...(truncated ? { truncated: true as const } : {}),
  }
  entries.push(entry)
  return entry
}
