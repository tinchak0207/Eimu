/**
 * tool-lifecycle.ts — 工具调用生命周期终态（2026-10-21）。
 *
 * 生产证据（已核实）：7,144 个唯一 tool 单元中 3,805 个（53.3%）永久 status=running
 * 且 output 为空；同一 (tool,input) 全等签名重复 2,790 组 / 7,092 次调用（最高 46 次）。
 * 模型把「发出调用」当「完成」。本模组只做三件事：
 *   1) 登记在跑调用（pending/running），completed/error 移除；
 *   2) 识别同签名重复调用（只通知，不阻断调用）；
 *   3) 收盘扫描超时未终态的调用——只标「未确认」，**禁止**把 running 改写成成功。
 *
 * 纯函数 + 极小 state 读写；状态字段见 types-gateway.SessionState（volatile，不进持久化）。
 * 接线：events-translate-tools（登记/移除/重复通知）、opencode-event-handler（idle 扫描）。
 */
import type { SessionState } from "./types-gateway.ts"

/** 超过此起点仍未收到 completed/error → 视为「未确认」的陈旧调用。 */
export const STALE_TOOL_MS = 10 * 60 * 1000

/** 在跑表上限：超出丢最旧（Map 插入序）。 */
export const TOOL_RUNNING_CAP = 256

/** 签名只取 input 序列化前 4KB，防止超大 payload 撑爆内存。 */
export const TOOL_SIGNATURE_MAX_CHARS = 4 * 1024

/** 在跑记录（签名 = tool + 稳定序列化 input；pending 阶段无 input 时为空串）。 */
export interface ToolRunningRecord {
  tool: string
  signature: string
  startedAt: number
}

/** 超时未终态的调用（只用于播报，不代表成功或失败）。 */
export interface StaleToolCall {
  callId: string
  tool: string
  startedAt: number
}

/** 稳定序列化：对象键排序、深度/节点有界（防环、防病态大 payload）。 */
function stableSerialize(value: unknown, depth: number, budget: { nodes: number }): string {
  if (budget.nodes > 500 || depth > 6) return '"…"'
  budget.nodes += 1
  if (value === null) return "null"
  const t = typeof value
  if (t === "string") return JSON.stringify(value)
  if (t === "number" || t === "boolean") return String(value)
  if (t === "undefined") return "undefined"
  if (t === "bigint") return `${String(value)}n`
  if (Array.isArray(value)) return `[${value.map((v) => stableSerialize(v, depth + 1, budget)).join(",")}]`
  if (t === "object") {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableSerialize(obj[k], depth + 1, budget)}`).join(",")}}`
  }
  return JSON.stringify(String(value))
}

/**
 * 调用签名：tool + 稳定序列化 input（键排序，前 4KB）。
 * input 缺席（pending 常无 input）返回空串——空串不参与重复判定，避免把
 * 「两个同工具但还没拿到参数的 pending」误判成重复。
 */
export function toolCallSignature(tool: string, input: unknown): string {
  if (input === null || input === undefined) return ""
  return `${tool}\u0000${stableSerialize(input, 0, { nodes: 0 }).slice(0, TOOL_SIGNATURE_MAX_CHARS)}`
}

function findBySignature(
  running: Map<string, ToolRunningRecord>,
  signature: string,
  excludeCallId: string,
): string | undefined {
  if (!signature) return undefined
  for (const [id, rec] of running) {
    if (id === excludeCallId) continue
    if (rec.signature === signature) return id
  }
  return undefined
}

/**
 * 登记一个在跑调用（pending/running 都可调）。
 * 返回 { duplicateOf }：同签名已有别的 callId 在跑时给出该 callId（只通知，不阻断）。
 * pending 阶段通常无 input；等 running 拿到 input 后补签名并做一次重复判定。
 */
export function noteToolRunning(
  state: SessionState,
  callId: string,
  tool: string,
  input: unknown,
  now: number,
): { duplicateOf?: string } {
  if (!callId) return {}
  const running = state.toolRunningCalls ?? (state.toolRunningCalls = new Map())
  const signature = toolCallSignature(tool, input)
  const existing = running.get(callId)
  if (existing) {
    if (!existing.signature && signature) {
      existing.signature = signature
      existing.tool = existing.tool || tool
      const duplicateOf = findBySignature(running, signature, callId)
      return duplicateOf ? { duplicateOf } : {}
    }
    return {}
  }
  const duplicateOf = findBySignature(running, signature, callId)
  if (running.size >= TOOL_RUNNING_CAP) {
    const oldest = running.keys().next().value
    if (oldest !== undefined) running.delete(oldest)
  }
  running.set(callId, { tool, signature, startedAt: now })
  return duplicateOf ? { duplicateOf } : {}
}

/** 收到终态（completed/error）→ 从在跑表移除。 */
export function noteToolTerminal(state: SessionState, callId: string): void {
  if (!callId) return
  state.toolRunningCalls?.delete(callId)
}

/**
 * 收盘扫描：返回超过 STALE_TOOL_MS 仍未终态的调用清单，并从在跑表移除。
 * 只报告事实，不推断成功/失败。
 */
export function sweepStaleTools(state: SessionState, now: number): StaleToolCall[] {
  const running = state.toolRunningCalls
  if (!running || running.size === 0) return []
  const stale: StaleToolCall[] = []
  for (const [callId, rec] of running) {
    if (now - rec.startedAt < STALE_TOOL_MS) continue
    stale.push({ callId, tool: rec.tool, startedAt: rec.startedAt })
  }
  for (const c of stale) running.delete(c.callId)
  stale.sort((a, b) => a.startedAt - b.startedAt)
  return stale
}
