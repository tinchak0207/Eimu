// S16 工程模式子代理：lane 约束、工程席位、回父摘要预算、工程事件、critic 派发入口。
// 设计文档 §3.8（子代理与 critic）/§3.1（Actor 归属）。lane 的**强制**在 S2 patch.ts 的
// checkLane（Actor={kind:"subagent",runId,lane} 越界 → LANE_VIOLATION）；本档只负责把 lane
// 规范化、在派发时传进子运行配置，并给出同一套语义的纯函数供接线处自检。
import expertIds from "../expert/expert-ids.json"
import { NODE_ID_RE } from "./specs.ts"
import { openProject, ProjectNotFoundError } from "./store.ts"
import type { Json, NodeId, ProjectEvent, RunId } from "./types.ts"

/** lane 上限（与 §3.8「nodeIds ≤20」同数，回父摘要的 nodeIds 也用这一条）。 */
export const LANE_MAX = 20
/** 回父子代理摘要的字节上限（§3.8：≤2000 token ≈ 4096 字节）。 */
export const SUBAGENT_SUMMARY_MAX_BYTES = 4096
/** 工程版席位后缀（§3.10 第 10 点：opencode.json 里为每个专家席位新增 `<expert>_p`）。 */
export const PROJECT_SEAT_SUFFIX = "_p"

/** 权威专家席位清单＝expert/expert-ids.json（S14 维护的唯一真源，不在本档另抄第二份）。 */
export const EXPERT_SEATS: readonly string[] = Array.isArray(expertIds.experts) ? expertIds.experts : []

export function isExpertSeat(value: unknown): value is string {
  return typeof value === "string" && EXPERT_SEATS.includes(value)
}

/**
 * lane 规范化：去重、保序、上限 LANE_MAX、非法 id 丢弃；空＝只读。
 * 只接受 §3.8 的 NodeId 形状（含 forEach 实例 `x#row`，patch.ts 的 checkLane 允许 lane
 * 条目按 base id 命中实例）。
 */
export function normalizeLane(raw: unknown): NodeId[] {
  const items = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []
  const out: NodeId[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (typeof item !== "string") continue
    const id = item.trim()
    if (!id || !NODE_ID_RE.test(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= LANE_MAX) break
  }
  return out
}

/** 子代理可用的写操作（与 patch.ts SUBAGENT_OPS 的写子集同义；读操作不归本函数管）。 */
export type LaneWriteOp = "add_node" | "set" | "write_result" | "remove_node" | "connect" | "disconnect" | "reroll"

const LANE_WRITE_OPS = new Set<string>(["add_node", "set", "write_result", "remove_node", "connect", "disconnect", "reroll"])

/**
 * 纯函数：该 lane 是否允许对 nodeId 执行 op。
 *  - 空 lane＝只读：一切写操作 false（§3.8「默认空=只读」）；
 *  - set/write_result（及其它 patch 允许的子代理写 op）：节点须在 lane 内；
 *  - add_node：只允许新节点落在 lane **指定的新 id** 上（引擎仍负责 EXISTS 检查）。
 * 命中规则与 patch.ts checkLane 逐字一致：lane 条目等于完整 id 或等于 base id。
 */
export function laneAllows(lane: readonly string[] | null | undefined, nodeId: string, op: string): boolean {
  const ids = normalizeLane(lane)
  if (ids.length === 0) return false
  if (typeof nodeId !== "string" || !nodeId) return false
  if (!LANE_WRITE_OPS.has(op)) return false
  const base = nodeId.includes("#") ? nodeId.slice(0, nodeId.indexOf("#")) : nodeId
  return ids.some((l) => l === nodeId || l === base)
}

/**
 * 工程模式席位映射：工程会话把专家席位换成 `<expert>_p`；旧会话（projectMode=false）原样返回；
 * 未知席位原样返回（是否允许派发由调用方的白名单决定，本函数不做拒绝）。
 */
export function projectSeatOf(expert: string | null | undefined, projectMode = true): string {
  const seat = typeof expert === "string" ? expert.trim() : ""
  if (!seat) return ""
  if (!projectMode) return seat
  if (seat.endsWith(PROJECT_SEAT_SUFFIX) && isExpertSeat(seat.slice(0, -PROJECT_SEAT_SUFFIX.length))) return seat
  if (!isExpertSeat(seat)) return seat
  return `${seat}${PROJECT_SEAT_SUFFIX}`
}

// ───────────────────────────── 回父摘要预算 ─────────────────────────────

export interface CompactSummary {
  text: string
  nodeIds: NodeId[]
  truncated: boolean
  bytes: number
}

const TRUNC_MARK = `\n[已截断：完整内容在节点产物，用 project_get 读取]`
const TRUNC_MARK_BYTES = Buffer.byteLength(TRUNC_MARK, "utf-8")

function utf8Prefix(text: string, maxBytes: number): string {
  let used = 0
  let out = ""
  for (const ch of text) {
    const n = Buffer.byteLength(ch, "utf-8")
    if (used + n > maxBytes) break
    used += n
    out += ch
  }
  return out
}

/**
 * 回父摘要：≤4096 字节、nodeIds ≤20、不含全文（全文在节点产物里）。
 * 超出按**整行**截断并附标注；单行本身超预算时按码点边界硬切（不产生半个汉字）。
 */
export function compactSubagentSummary(text: string, nodeIds: readonly string[] = []): CompactSummary {
  const raw = typeof text === "string" ? text : ""
  const ids = normalizeLane(nodeIds)
  const bytes = Buffer.byteLength(raw, "utf-8")
  if (bytes <= SUBAGENT_SUMMARY_MAX_BYTES) return { text: raw, nodeIds: ids, truncated: false, bytes }

  const budget = SUBAGENT_SUMMARY_MAX_BYTES - TRUNC_MARK_BYTES
  const lines = raw.split("\n")
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    const add = Buffer.byteLength(line, "utf-8") + (kept.length > 0 ? 1 : 0)
    if (used + add > budget) break
    used += add
    kept.push(line)
  }
  const body = kept.length > 0 ? kept.join("\n") : utf8Prefix(raw, budget)
  const out = `${body}${TRUNC_MARK}`
  return { text: out, nodeIds: ids, truncated: true, bytes: Buffer.byteLength(out, "utf-8") }
}

// ───────────────────────────── 工程事件 ─────────────────────────────

export interface SubagentProjectEventPayload {
  /** node_status=单个节点状态；run_finished=子代理整路收尾（缺省）。 */
  kind?: "node_status" | "run_finished"
  node?: NodeId
  runId?: RunId
  status?: string
  nodeIds?: readonly string[]
  summary?: string
  data?: Record<string, Json>
}

/**
 * 子代理完成事件写进工程 events.jsonl（§3.8：finishRun 不唤醒父会话，主代理经 project_get
 * 的事件取到）。工程不存在 → 静默 no-op（旧会话路径零副作用）；写失败只打日志，不阻断收尾。
 */
export async function emitSubagentProjectEvent(
  parentSessionId: string,
  payload: SubagentProjectEventPayload = {},
): Promise<ProjectEvent | null> {
  if (typeof parentSessionId !== "string" || !parentSessionId) return null
  let store
  try {
    store = await openProject(parentSessionId)
  } catch (e) {
    if (e instanceof ProjectNotFoundError) return null
    // 非「工程不存在」的读盘错误：如实记一行，不抛（收尾路径不得因事件失败而中断）。
    console.warn(`[gateway] project event skipped (open failed): session=${parentSessionId} ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
  const ids = normalizeLane(payload.nodeIds)
  const data: Record<string, Json> = { subagent: "done", status: payload.status ?? "done" }
  if (ids.length > 0) data.node_ids = ids as Json
  if (typeof payload.summary === "string" && payload.summary) data.summary = payload.summary
  Object.assign(data, payload.data ?? {})
  try {
    const events = await store.appendEvents([
      {
        kind: payload.kind ?? "run_finished",
        ...(payload.node ? { node: payload.node } : {}),
        ...(payload.runId ? { run: payload.runId } : {}),
        data,
      },
    ])
    return events[0] ?? null
  } catch (e) {
    console.warn(
      `[gateway] project event append failed (ignored): session=${parentSessionId} kind=${payload.kind ?? "run_finished"} ${e instanceof Error ? e.message : String(e)}`,
    )
    return null
  }
}

// ───────────────────────────── critic 派发入口（S9/S17 接线）─────────────────────────────

export const CRITIC_EXPERT = "critic"

export interface CriticDispatchInput {
  sessionId: string
  qcNodeId: NodeId
  /** 评审任务书（含 rubric、被审节点、verdict 形状要求）。 */
  prompt: string
  label?: string
  /** 缺省后台执行（与现有 async dispatch 默认一致）。 */
  async?: boolean
}

export interface CriticDispatchRequest {
  sessionId: string
  label: string
  prompt: string
  expert: string
  lane: NodeId[]
  async?: boolean
}

export type CriticDispatchFn = (req: CriticDispatchRequest) => Promise<Record<string, unknown>>

export interface CriticDispatchOutcome {
  ok: boolean
  seat: string
  lane: NodeId[]
  subagentId?: string
  /** 子会话 id。执行器用来确认 critic 与父会话不是同一个。 */
  sessionId?: string
  agent?: string
  /** fake / 同步 critic 把判决放在派发回执里；异步真派发没有这个字段。 */
  verdict?: unknown
  /** checkCriticReceipt 要的 assistant tool 回执。 */
  messages?: unknown
  code?: string
  error?: string
}

/** 默认派发＝现有子代理派发（/internal/subagent/dispatch 同一个 handler）；懒加载避免模组环。 */
async function defaultCriticDispatch(req: CriticDispatchRequest): Promise<Record<string, unknown>> {
  const { handleSubagentDispatch } = await import("../subagent-dispatch.ts")
  const res = await handleSubagentDispatch(
    new Request("http://127.0.0.1/internal/subagent/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    }),
  )
  return (await res.json()) as Record<string, unknown>
}

/**
 * 触发一次评审子代理：工程版 `critic_p` 席位 + lane=[qcNodeId]，verdict 由子代理用
 * `write_result` 写回该 QC 节点（§3.8）。派发本身走现有子代理通路；本片只钉形态与测试。
 */
export async function dispatchCriticRun(
  input: CriticDispatchInput,
  dispatch: CriticDispatchFn = defaultCriticDispatch,
): Promise<CriticDispatchOutcome> {
  const seat = projectSeatOf(CRITIC_EXPERT, true)
  const lane = normalizeLane([input?.qcNodeId])
  if (lane.length !== 1) {
    return { ok: false, seat, lane: [], code: "bad_input", error: `qc 节点 id 非法：${JSON.stringify(input?.qcNodeId)}` }
  }
  if (typeof input.sessionId !== "string" || !input.sessionId) {
    return { ok: false, seat, lane, code: "bad_input", error: "缺少工程会话 id" }
  }
  if (typeof input.prompt !== "string" || !input.prompt.trim()) {
    return { ok: false, seat, lane, code: "bad_input", error: "缺少评审任务书" }
  }
  const req: CriticDispatchRequest = {
    sessionId: input.sessionId,
    label: (input.label ?? "").trim() || `评审 ${lane[0]}`,
    prompt: input.prompt,
    expert: CRITIC_EXPERT,
    lane,
    async: input.async !== false,
  }
  try {
    const res = (await dispatch(req)) ?? {}
    const childSession = typeof res.session_id === "string" ? res.session_id : typeof res.child_session_id === "string" ? res.child_session_id : undefined
    const extra = {
      ...(childSession ? { sessionId: childSession } : {}),
      ...(typeof res.agent === "string" ? { agent: res.agent } : {}),
      ...(res.verdict !== undefined ? { verdict: res.verdict } : {}),
      ...(res.messages !== undefined ? { messages: res.messages } : {}),
    }
    if (res.ok === true) {
      return { ok: true, seat, lane, ...(typeof res.subagent_id === "string" ? { subagentId: res.subagent_id } : {}), ...extra }
    }
    return {
      ok: false,
      seat,
      lane,
      code: typeof res.code === "string" ? res.code : "dispatch_failed",
      error: typeof res.error === "string" ? res.error : "评审子代理派发失败",
    }
  } catch (e) {
    return { ok: false, seat, lane, code: "dispatch_failed", error: e instanceof Error ? e.message : String(e) }
  }
}
