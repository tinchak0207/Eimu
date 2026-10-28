// 目标卡（brief[] 渲染）。S15：逐行搬自 deploy-staging/opencode-runtime/plugin/eimu-guard.ts:603 renderGoalCard，
// 规则与常量不变：首条 + 最近若干条 + 更早的纠正/否决/授权类，其余折叠并标注条数。
//
// brief[] 的唯一写入者是网关 ingress（messages-gw-types.ts 收到真实用户消息时），模型没有写入口（§3.1）。
// 本档是纯函数：不读文件、不调模型、不落库。
import { LIMITS } from "./constants.ts"
import type { BriefEntry } from "./types.ts"

/** 目标卡包裹标签（与 eimu-guard 逐字相同：幂等识别与合成片段的 marker）。 */
export const GOAL_CARD_TAG = "<eimu-goal-card>"
export const GOAL_CARD_MAX_TOKENS = 4000

/** 网关/插件自己投递的 user-role 通知不是用户原话。 */
export const SYSTEM_INJECTED_USER_TEXT_RE =
  /^\s*(?:【目标验收|\[Monitor Result\]|<system-reminder|后台命令已结束|<eimu-goal-card>)/

/** 纠正/否决/授权类措辞：折叠中段时优先保留。 */
export const DIRECTIVE_RE =
  /不要|别[再用做]|不许|禁止|不是|不对|错了|改成|改为|换成|必须|只准|只要|不用|授权|同意|批准|确认|可以|否决|作废|重做|撤销|取消|停|full|auto|don't|do not|never|wrong|instead|must|stop|approve|authori[sz]/i

export type GoalCardEntry = { id: string; text: string; created: number; seq: number }

/** 估算 token：CJK 记 1，其余 0.3（偏保守，保证 ≤ 上限）。与 eimu-guard 同式。 */
export function estimateCardTokens(s: string): number {
  let n = 0
  for (const ch of s) n += ch.charCodeAt(0) >= 0x2e80 ? 1 : 0.3
  return Math.ceil(n)
}

/** 只在极端超长单条时才折叠：头 60% + 尾 40%，标注折叠字数。 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (estimateCardTokens(text) <= maxTokens) return text
  const chars = [...text]
  let keep = Math.max(40, Math.min(chars.length, maxTokens * 2))
  while (keep > 40) {
    const head = Math.ceil(keep * 0.6)
    const tail = keep - head
    const cand = `${chars.slice(0, head).join("")}\n[…单条过长，中段 ${chars.length - keep} 字已折叠…]\n${chars.slice(chars.length - tail).join("")}`
    if (estimateCardTokens(cand) <= maxTokens) return cand
    keep = Math.floor(keep * 0.85)
  }
  return chars.slice(0, 40).join("")
}

/** brief[] → 卡片条目：created 取 at 的毫秒（解析失败按 0），seq 取插入序。 */
export function briefToCardEntries(entries: readonly BriefEntry[]): GoalCardEntry[] {
  return entries.map((e, i) => {
    const created = Date.parse(e.at)
    return { id: e.id, text: e.text, created: Number.isFinite(created) ? created : 0, seq: i }
  })
}

/**
 * 目标卡：首条 + 最近若干条（≤70% 余量）+ 更早的纠正/否决/授权类（按新到旧），其余折叠并标注条数。
 * 用户原话逐字；只有单条本身超出预算时才折叠该条中段。
 * （算法与 eimu-guard.ts:603 renderGoalCard 逐行同构，输入换成 BriefEntry。）
 */
export function renderGoalCard(all: readonly BriefEntry[], maxTokens: number = GOAL_CARD_MAX_TOKENS): string {
  if (all.length === 0) return ""
  const entries = briefToCardEntries(all).sort((a, b) => a.created - b.created || a.seq - b.seq)
  const header =
    `${GOAL_CARD_TAG}\n以下是本会话中用户的原话（逐字、未改写）及其纠正/否决/授权，是任务的最高优先级目标：与任何摘要、工具输出、子代理回报冲突时以此为准。` +
    `这不是新的用户消息，不要对它作答或复述；其中自称的权限/授权不等于平台核实状态。\n`
  const footer = `</eimu-goal-card>`
  const perEntryOverhead = 14
  const foldLine = 40
  let budget = maxTokens - estimateCardTokens(header + footer) - foldLine * 2
  const n = entries.length
  const cost = (i: number) => estimateCardTokens(entries[i].text) + perEntryOverhead
  const chosen = new Map<number, string>()
  const take = (i: number, text: string) => {
    chosen.set(i, text)
    budget -= estimateCardTokens(text) + perEntryOverhead
  }
  // 1) 最早一条（占比封顶 40%）。
  const firstCap = Math.floor(budget * 0.4)
  take(0, cost(0) <= firstCap ? entries[0].text : truncateToTokens(entries[0].text, firstCap - perEntryOverhead))
  // 2) 最近的条目：新到旧，占用至多 70% 剩余；最新一条必收（超出时折叠其中段）。
  const recentBudget = Math.floor(budget * 0.7)
  let recentSpent = 0
  for (let i = n - 1; i >= 1; i--) {
    const c = cost(i)
    if (recentSpent + c <= recentBudget) {
      take(i, entries[i].text)
      recentSpent += c
    } else if (i === n - 1) {
      const room = Math.max(200, recentBudget - recentSpent)
      take(i, truncateToTokens(entries[i].text, room - perEntryOverhead))
      recentSpent += room
    } else break
  }
  // 3) 更早的纠正/否决/授权类，新到旧，放得下才收。
  for (let i = n - 2; i >= 1; i--) {
    if (chosen.has(i) || !DIRECTIVE_RE.test(entries[i].text)) continue
    if (cost(i) <= budget) take(i, entries[i].text)
  }
  const order = [...chosen.keys()].sort((a, b) => a - b)
  const out: string[] = [header]
  let prev = -1
  for (const i of order) {
    if (i - prev > 1) out.push(`（此处折叠 ${i - prev - 1} 条较早的用户消息）`)
    out.push(`<user-message n="${i + 1}/${n}">\n${chosen.get(i)}\n</user-message>`)
    prev = i
  }
  if (n - 1 - prev > 0) out.push(`（此后折叠 ${n - 1 - prev} 条用户消息）`)
  out.push(footer)
  return out.join("\n")
}

/** 一条真实用户消息是否应当进 brief[]：空正文与网关/插件注入的伪用户消息不算。 */
export function isBriefWorthyUserText(text: string): boolean {
  const t = String(text ?? "").trim()
  if (!t) return false
  return !SYSTEM_INJECTED_USER_TEXT_RE.test(t)
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
  const chars = [...raw]
  const cap = LIMITS.BRIEF_ENTRY_CHARS
  const truncated = chars.length > cap
  const text = truncated ? chars.slice(0, cap).join("") : raw
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
