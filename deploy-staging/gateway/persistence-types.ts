import type { Database } from "bun:sqlite"
// ---- 型别 ----

/** 可持久化的 SessionState 子集（结构化 duck-type，避免与 index.ts 循环 import）。 */
export interface PersistableState {
  sessionId: string
  apiKey: string
  opencodeSessionId: string
  eventCounter: number
  replayBuffer: { id: number; frame: Uint8Array; strippable?: boolean }[]
  lastActivityAt: number
  partTextEmitted: Map<string, { emittedLen: number }>
  announcedUrls: Set<string>
  toolStatusSeen: Set<string>
  toolInvokeSeen: Set<string>
  stepCostLogged: Set<string>
  messageRole: Map<string, string>
  suppressedParts: Set<string>
  canvasSummary?: unknown
  canvasSummaryAt?: number
  /** 画布持久快照（canvas.node.* 事件套用后的节点/连线），重启后回灌 canvasStates。 */
  canvasSnapshot?: { nodes?: unknown[]; connections?: unknown[]; [k: string]: unknown }
  /** 工作流持久快照（与 canvasSnapshot 同构）：ActiveWorkflow 的可恢复子集
   *  （模板 id、节点流、节点状态/结果/成本），重启后回灌 workflows Map。 */
  workflowSnapshot?: Record<string, unknown>
  vettingInjected: boolean
  userMemory?: { user_profile: Record<string, unknown>; lessons: string[] }
  profileOnboardingPending?: boolean
  compact?: { lastCount: number; at: number }
  /** N1（2026-08-27）：in-flight turn 打点——turn 开始时写入、正常结束清零；
   *  gateway 重启后恢复会话时据此判断是否要自动重投 lastPromptBody。 */
  lastTurnActiveAt?: number
  /** 会话摘要标题（2026-09-12）：opencode 首条用户消息后异步生成，gateway
   *  在 session.idle 钩子抓取后镜像进 state 并随防抖落盘；null/undef=尚未生成。 */
  sessionTitle?: string | null
  /** 2026-10-02：模板偏离 token（网关签发、单次核销、TTL 15 分）。落持久层＝跨
   *  agent-gateway 重启存活（否则用户批准过的偏离出口会被重启关上）。 */
  tplDeviateToken?: { token: string; at: number } | null
}
/** DB row 的 data 栏位 JSON 形状（Map/Set 均序列化为阵列）。 */
export interface PersistedData {
  eventCounter: number
  replayBuffer: { id: number; frame: string; merge?: { name: string; ids: number[]; lens: number[] }; strippable?: boolean }[]
  lastActivityAt: number
  partTextEmitted: [string, { emittedLen: number }][]
  announcedUrls: string[]
  toolStatusSeen: string[]
  toolInvokeSeen: string[]
  stepCostLogged: string[]
  messageRole: [string, string][]
  suppressedParts: string[]
  canvasSummary?: unknown
  canvasSummaryAt?: number
  canvasSnapshot?: { nodes?: unknown[]; connections?: unknown[]; [k: string]: unknown }
  workflowSnapshot?: Record<string, unknown>
  vettingInjected: boolean
  userMemory?: { user_profile: Record<string, unknown>; lessons: string[] }
  profileOnboardingPending?: boolean
  compact?: { lastCount: number; at: number }
  lastTurnActiveAt?: number
  /** 会话摘要标题镜像（2026-09-12）：null=尚未生成（占位标题已在抓取侧归一化掉）。 */
  title?: string | null
  /** 2026-10-02：模板偏离 token 镜像（shape 防护在 hydrateRow，坏形状一律还原为 null）。 */
  tplDeviateToken?: { token: string; at: number } | null
}

export interface PersistedRow {
  sessionId: string
  apiKey: string
  opencodeSessionId: string
  createdAt: number
  updatedAt: number
  data: PersistedData
}
export interface Migration {
  version: number
  name: string
  up(database: Database): void
}

export interface MigrationReport {
  from: number
  to: number
  applied: number[]
  failures: { version: number; name: string; error: string }[]
}
export interface UserSettings {
  interrupt_mode: string
  persona: string
  cost_mode: string
  /** 野兽模式（MOE 改革，2026-09-08）：settings 布林，dispatch 时快照进 subagent run。 */
  beast_mode?: boolean
}
export interface ReworkRecord {
  runId: string
  parentGw: string
  parentOc: string
  childOc: string
  agent: string
  label: string
  beast: boolean
  asyncMode: boolean
  reworkCount: number
  updatedAt: number
}
/**
 * critic 分数来源（v3，2026-10-03）。
 *   * `measured`：存在**独立于被测模型**的量测来源（如对成品跑硬检）→ 唯一可套用数值阈值者。
 *   * `model_self`：同族模型自评 → 只作便宜、快、可当筛子的讯号，永不构成验收 oracle（禁同源断言）。
 *   * `human`：人工接受/拒绝 → 外生标签，另存 human_labels，不是数值量测。
 * 没有分数时 score 为 null、不得填 0 假值。score_source 是「这列分数讯号的来源」：
 * `model_self`／`human` 允许与 null score 并存（分类判决本就没有数值）；`measured` 则必须有数值，
 * 否则不落来源（宣告了量测就必须有数字，不得制造假量测）。
 */
export type CriticScoreSource = "measured" | "model_self" | "human"
