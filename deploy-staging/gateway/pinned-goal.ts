// 原始需求钉（7db4e0872 起，2026-10-28）。H19（2026-11-04）：原 messages-gw-types.ts 同名代码**原样搬入**本叶子模组，
// 让非 admission 回合（唤醒/工作流/收件箱/目标验收 nudge）复用同一 suffix，又不引入 workflow-gw ⇄ messages-gw-types 循环依赖。
// messages-gw-types.ts 原名 re-export，admission 路径逐字不变。
import { extractPinnedConstraints } from "./compaction-policy.ts"
import type { SessionState } from "./types-gateway.ts"

// 2026-10-28：用户原始目标全文钉死上限（压缩后 active context 只剩 summary，
// 每回合由 system 重注原文；与硬约束句并存）。
const ORIGINAL_USER_PROMPT_CAP = 12_000

type PinnedSession = SessionState & { pinnedConstraints?: string; originalUserPrompt?: string; userRevisions?: string[] }

// 2026-11-02 长期可改：首回合之后的用户修订（「只改 X、其余别动」「主角改叫…」「节奏慢一点」）
// 原本只活在 opencode 对话里，压缩后变 summary 一句话、重启后更不可考——多轮之后人物/关系/
// 节奏层被悄悄回退。复用原始目标钉的同一条路：有界台账、持久化、每回合 system 重注。
export const USER_REVISION_MAX_ENTRIES = 16
export const USER_REVISION_ENTRY_CAP = 400
export const USER_REVISION_TOTAL_CAP = 3000

/** 修订条目正文：去附件块、压空白、截断；纯确认/空话不入账（回 ""）。 */
export function userRevisionEntry(content: string): string {
  const text = String(content ?? "")
    .replace(/\[ATTACHMENTS_BLOCK\][\s\S]*?\[\/ATTACHMENTS_BLOCK\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  // 太短的「好」「继续」「可以」不承载修订语义，入账只会挤掉真修订。
  if (text.length < 4) return ""
  if (/^(好的?|可以|行|继续|ok|OK|嗯+|是的?|对|确认|没问题)[。！!.~～\s]*$/.test(text)) return ""
  return text.length > USER_REVISION_ENTRY_CAP ? `${text.slice(0, USER_REVISION_ENTRY_CAP)}…` : text
}

export function rememberPinnedConstraints(state: SessionState, content: string): void {
  const bag = state as PinnedSession
  // 首回合判定：原始目标尚未落账（含重启后 turnGen 归零但已有原始目标的老会话 → 非首回合）。
  const firstTurn = bag.originalUserPrompt === undefined && (state.turnGen ?? 0) === 0
  if (bag.pinnedConstraints === undefined) {
    bag.pinnedConstraints = firstTurn ? extractPinnedConstraints(content) : ""
  }
  // 原始目标全文：首回合写一次（持久化，见 persistence-io）；空正文不占位。
  if (firstTurn) {
    const raw = String(content ?? "").trim()
    if (raw) bag.originalUserPrompt = raw.slice(0, ORIGINAL_USER_PROMPT_CAP)
    return
  }
  const entry = userRevisionEntry(content)
  if (!entry) return
  const list = Array.isArray(bag.userRevisions) ? bag.userRevisions : []
  if (list[list.length - 1] === entry) return // 同一则重送/重试不重复入账
  bag.userRevisions = [...list, entry].slice(-USER_REVISION_MAX_ENTRIES)
}

/** 压缩不可丢的用户原始目标（首回合全文，≤12k）。 */
export function originalUserPromptText(state: SessionState): string {
  const text = (state as PinnedSession).originalUserPrompt ?? ""
  return text.length > ORIGINAL_USER_PROMPT_CAP ? text.slice(0, ORIGINAL_USER_PROMPT_CAP) : text
}

export function pinnedConstraintsText(state: SessionState): string {
  const text = (state as PinnedSession).pinnedConstraints ?? ""
  return text.length > 2000 ? text.slice(0, 2000) : text
}

/** 用户后续修订台账（新的优先保留，总长 ≤3000；编号保持时间序）。 */
export function userRevisionsText(state: SessionState): string {
  const list = (state as PinnedSession).userRevisions
  if (!Array.isArray(list) || list.length === 0) return ""
  const kept: string[] = []
  let total = 0
  for (let i = list.length - 1; i >= 0; i--) {
    const line = `${i + 1}. ${list[i]}`
    if (total + line.length > USER_REVISION_TOTAL_CAP) break
    kept.unshift(line)
    total += line.length + 1
  }
  return kept.join("\n")
}

/** 每回合钉在 system 尾的三段：原始目标 → 后续修订 → 硬约束。 */
export function pinnedSystemSuffix(state: SessionState): string {
  let out = ""
  const originalGoal = originalUserPromptText(state)
  if (originalGoal) out += `\n\n【用户原始目标·压缩不可丢】\n${originalGoal}`
  const revisions = userRevisionsText(state)
  if (revisions) {
    out += `\n\n【用户后续修订·压缩不可丢】（按时间序，越后越新；与原始目标冲突以最新修订为准；` +
      `修订只改它点名的那一层，未点名的人物/关系/设定/节奏一律保持既有版本）\n${revisions}`
  }
  const pinned = pinnedConstraintsText(state)
  if (pinned) out += `\n\n【硬约束·必须遵守】\n${pinned}`
  return out
}

/**
 * H19：非 admission 回合的投递体挂原始需求钉（只给模型）。
 * opencode 1.18 每回合 system ＝ agent.prompt ＋ 环境 ＋ **本回合 user 消息自带的 body.system**；
 * 唤醒体只有 parts、没有 system ⇒ 该回合模型看不到【用户原始目标】【后续修订】【硬约束】（根因 A）。
 * - 只写 body.system：不进 parts ⇒ 不上屏（slimHistoryMessages 只投影 info.id/role）、不被 eimu-guard 目标卡当用户原话收录。
 * - 幂等：body 已带非空 system（admission 体／其重放）原样返回，不叠加；每次唤醒都从 state 现算、赋值不追加。
 * - 长度：沿用 pinnedSystemSuffix 既有上限（原文 ≤12000、修订 ≤3000、硬约束 ≤2000）。
 * - 降级：state 缺失或旧会话无原始需求/修订/约束 ⇒ 原样返回（不带 system 字段），与修前逐字相同。
 */
export function withPinnedWakeSystem<T extends object>(state: SessionState | null | undefined, body: T): T & { system?: string } {
  const existing = (body as { system?: unknown }).system
  if (!state || (typeof existing === "string" && existing.length > 0)) return body
  const suffix = pinnedSystemSuffix(state).replace(/^\n+/, "")
  if (!suffix) return body
  return { ...body, system: suffix }
}
